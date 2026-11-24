/** The key brought forward, in the bar (ADR-0051 §4): ‹ › over the
 * annotations it signed, in the text's order as what awaits my reply
 * (`stepAwaiting`); the annotation reached becomes the active one. */
import { mount, unmount } from "svelte";
import type { AnnotationIndex } from "../../../lib/src/index.js";
import type { ActiveAnnotation } from "../../view-model/active-annotation.js";
import KeyNav from "./KeyNav.svelte";
import { stepAwaiting } from "./awaiting-nav.js";
import type { SignerKeys } from "./signer-keys.svelte.js";

const NOWHERE = Number.MAX_SAFE_INTEGER;

export function attachKeyNav(
  host: Element,
  options: {
    keys: SignerKeys;
    index: AnnotationIndex;
    active: ActiveAnnotation;
  },
): { destroy(): void } {
  const { keys, index, active } = options;
  const step = (by: -1 | 1) => {
    const chosen = keys.chosen;
    if (!chosen) return;
    const { byId } = index.current();
    const place = (id: string) => ({
      id,
      start: byId.get(id)?.range?.start ?? NOWHERE,
    });
    const items = (keys.signed.get(chosen.fingerprint) ?? []).map(place);
    const next = stepAwaiting(
      items,
      active.id === undefined ? undefined : place(active.id),
      by,
    );
    if (next) active.set(next, "card");
  };
  const nav = mount(KeyNav, { target: host, props: { keys, onStep: step } });
  return {
    destroy() {
      void unmount(nav);
    },
  };
}
