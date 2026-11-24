/** What to alert of (ADR-0060 §1, NL1 to NL4), from one version
 * of what awaits my reply to the next: an annotation that awaits me and
 * whose thread has gained an entry since it was last seen. Seen: at
 * opening, while it awaits me, or, everything verified, out of the list —
 * so one that comes in without a new entry (set aside then put back, my
 * keys known late) alerts of nothing, nor does my own entry. Nothing is
 * seen nor told while a signature is still to judge: the index keeps an
 * annotation's state then, whatever came in. Pure: the page says when it
 * is still opening, and whether it is watched. */
import { count } from "../../perf/index.js";

/** An annotation's thread: the annotation, then its replies. */
export interface Thread {
  readonly id: string;
  readonly replies: readonly unknown[];
}

export interface AlertObservation {
  annotations: readonly Thread[];
  /** What awaits my reply now (`AwaitingIndex.current()`). */
  awaiting: ReadonlySet<string>;
  /** Until synchronized for the first time, and who I am known. */
  opening: boolean;
  /** Every signature judged. */
  settled: boolean;
  /** The view is looked at: what came in is seen, nothing is told. */
  watched: boolean;
}

export class AwaitingAlerts {
  /** An annotation's id → its thread's entries when last seen. */
  private readonly seen = new Map<string, number>();
  private armed = false;

  /** The annotations to alert of, in their order; none: nothing to tell. */
  observe(observation: AlertObservation): string[] {
    count("alerts.observe");
    const { annotations, awaiting, opening, settled, watched } = observation;
    if (!this.armed) {
      for (const thread of annotations) {
        count("alerts.thread");
        this.seen.set(thread.id, entries(thread));
      }
      this.armed = !opening && settled;
      return [];
    }
    if (!settled) return [];
    const fresh: string[] = [];
    for (const thread of annotations) {
      count("alerts.thread");
      const now = entries(thread);
      if (awaiting.has(thread.id) && now > (this.seen.get(thread.id) ?? 0)) {
        fresh.push(thread.id);
      }
      this.seen.set(thread.id, now);
    }
    return watched ? [] : fresh;
  }
}

function entries(thread: Thread): number {
  return 1 + thread.replies.length;
}
