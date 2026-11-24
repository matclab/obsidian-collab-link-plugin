import { count } from "../../perf/index.js";

/** One column of the side-by-side view, in
 * source lines: the editor, or the rendering. */
export interface Pane {
  /** Where its scroll events come from, and the user's gestures. */
  element: Element;
  /** The source line at its top, fractional. */
  line(): number;
  /** Scrolls it to put `line` at its top, as far as it can go. */
  show(line: number): void;
}

export interface ScrollSync {
  start(): void;
  stop(): void;
  /** Brings the follower level with the leader, at the next frame: when
   * the view is shown, or the rendering has changed. */
  align(): void;
}

// The user's hand on a column: a pointer (its scrollbar included), a
// wheel, a touch.
const GESTURES = ["pointerdown", "wheel", "touchstart"] as const;

/** Scrolls each column with the other. The column the user touched last
 * leads (the first one at first, and after a gesture outside both — a
 * card chosen brings its passage into the editor; a key typed in the
 * first one gives it the lead, a key elsewhere leaves it, as Page Down
 * scrolls what was clicked last); only its scrolls are followed, at the
 * next frame, once however many came. The follower's own scrolls — the
 * one it is given, or its lines measured again, which CodeMirror and the
 * browser keep in place by scrolling — move nothing back. */
export function createScrollSync(
  first: Pane,
  second: Pane,
  frame: (run: () => void) => void = (run) => requestAnimationFrame(run),
  /** Where the user's gestures are heard. */
  events: EventTarget = document,
): ScrollSync {
  let running = false;
  let leader: Pane = first;
  let pending = false;

  const follow = () => {
    pending = false;
    if (!running) return;
    count("sync.scroll");
    const other = leader === first ? second : first;
    other.show(leader.line());
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    frame(follow);
  };
  const inside = (pane: Pane, event: Event) =>
    event.target instanceof Node && pane.element.contains(event.target);
  for (const type of GESTURES) {
    events.addEventListener(
      type,
      (event) => {
        leader = inside(second, event) ? second : first;
      },
      { capture: true, passive: true },
    );
  }
  events.addEventListener(
    "keydown",
    (event) => {
      if (inside(first, event)) leader = first;
    },
    { capture: true, passive: true },
  );
  for (const pane of [first, second]) {
    pane.element.addEventListener(
      "scroll",
      () => {
        if (running && pane === leader) schedule();
      },
      { passive: true },
    );
  }
  return {
    start() {
      running = true;
    },
    stop() {
      running = false;
    },
    align: schedule,
  };
}
