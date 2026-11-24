import { flushSync, mount, unmount } from "svelte";
import type { Presence, SignatureIndex } from "../../../lib/src/index.js";
import { shownName } from "../annotations/card-model.js";
import View from "./HereNow.svelte";

export interface HereNow {
  destroy(): void;
}

/** Mounts the "Here now" line (`HereNow.svelte`, ADR-0025 §7), rendered
 * from `presence.others()` when the presence changes, and only then. */
export function createHereNow(
  container: Element,
  presence: Pick<Presence, "others" | "subscribe">,
  /** The presences' signatures (an index of presence only): a signed one
   * shows its key's short fingerprint (docs/protocol/06-identity.md). */
  signatures?: SignatureIndex,
): HereNow {
  const view = mount(View, { target: container, props: {} });
  const render = () => {
    const signed = signatures?.current();
    view.show(
      presence.others().map(({ key, name, color }) => {
        const verdict = signed?.of("presence", key);
        return {
          // Attested (ID-39): the attested name, not the one chosen.
          name: verdict ? shownName(name, verdict) : name,
          color,
          ...(verdict?.signed && { short: verdict.short }),
          ...(verdict?.signed &&
            verdict.attested && { issuer: verdict.attested.issuer }),
        };
      }),
    );
    flushSync();
  };
  const stops = [
    presence.subscribe(render),
    ...(signatures ? [signatures.subscribe(render)] : []),
  ];
  render();
  return {
    destroy() {
      for (const stop of stops) stop();
      signatures?.destroy();
      void unmount(view);
    },
  };
}
