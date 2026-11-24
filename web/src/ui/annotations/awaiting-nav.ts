/** ‹ › over what awaits my reply (ADR-0050 §5): in the text's order, an
 * annotation without a passage last; around at both ends, as the review's
 * walk. */
import { mount, unmount } from "svelte";
import type { AnnotationIndex } from "../../../lib/src/index.js";
import type { ActiveAnnotation } from "../../view-model/active-annotation.js";
import type { AwaitingIndex } from "../../view-model/awaiting-index.js";
import AwaitingNav from "./AwaitingNav.svelte";

interface Placed {
  id: string;
  start: number;
}

const byText = (x: Placed, y: Placed) =>
  x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The annotation to go to: the first (`by` 0), or the next or previous
 * from the active one — from where it stands in the text if it isn't in
 * the list. */
export function stepAwaiting(
  items: readonly Placed[],
  active: Placed | undefined,
  by: -1 | 0 | 1,
): string | undefined {
  const sorted = [...items].sort(byText);
  if (sorted.length === 0) return undefined;
  if (by === 0 || !active) return (by === -1 ? sorted.at(-1) : sorted[0])?.id;
  const at = sorted.findIndex((item) => item.id === active.id);
  if (at >= 0) {
    return sorted[(at + by + sorted.length) % sorted.length]?.id;
  }
  if (by === 1) {
    return (sorted.find((item) => byText(item, active) > 0) ?? sorted[0])?.id;
  }
  const before = sorted.filter((item) => byText(item, active) < 0);
  return (before.at(-1) ?? sorted.at(-1))?.id;
}

const NOWHERE = Number.MAX_SAFE_INTEGER;

/** The count and the arrows, in `host` (the header, beside the modes),
 * and F8 / Shift+F8 in `keys`: the annotation reached becomes the active
 * one, as a click on its card — its passage comes into view. */
export function attachAwaitingNav(
  host: Element,
  options: {
    awaiting: AwaitingIndex;
    index: AnnotationIndex;
    active: ActiveAnnotation;
    keys?: EventTarget;
  },
): { step(by: -1 | 0 | 1): void; destroy(): void } {
  const { awaiting, index, active } = options;
  const step = (by: -1 | 0 | 1) => {
    const { byId } = index.current();
    const place = (id: string): Placed => ({
      id,
      start: byId.get(id)?.range?.start ?? NOWHERE,
    });
    const items = [...awaiting.current()].map(place);
    const next = stepAwaiting(
      items,
      active.id === undefined ? undefined : place(active.id),
      by,
    );
    if (next) active.set(next, "card");
  };
  const nav = mount(AwaitingNav, { target: host, props: { onStep: step } }) as {
    setCount(count: number): void;
  };
  const show = () => nav.setCount(awaiting.current().size);
  const unsubscribe = awaiting.subscribe(show);
  show();
  const onKey = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (event.key !== "F8" || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };
  options.keys?.addEventListener("keydown", onKey);
  return {
    step,
    destroy() {
      unsubscribe();
      options.keys?.removeEventListener("keydown", onKey);
      void unmount(nav);
    },
  };
}
