import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { AwaitingAlerts } from "./awaiting-alerts.js";

// ADR-0060 §1, phase 34 (NL1 to NL4), against a reference written from the
// rules: entries of me and of others, some verified late, set aside and put
// back, observed while opening or after, watched or not.

const IDS = ["a", "b"];

interface Entry {
  mine: boolean;
  verified: boolean;
}

/** The document, and what the awaiting index would say of it. */
class World {
  readonly threads = new Map<string, Entry[]>();
  /** An annotation's id → its entries when set aside. */
  readonly aside = new Map<string, number>();
  private awaitingBefore = new Set<string>();

  settled(): boolean {
    return [...this.threads.values()].every((t) => t.every((e) => e.verified));
  }

  /** ADR-0050 §1 and its index: none of mine, or another's after my
   * last, unless set aside since; a thread with an entry still to judge
   * keeps its state. */
  awaiting(): Set<string> {
    const result = new Set<string>();
    for (const [id, thread] of this.threads) {
      if (thread.some((e) => !e.verified)) {
        if (this.awaitingBefore.has(id)) result.add(id);
        continue;
      }
      const last = thread.map((e) => e.mine).lastIndexOf(true);
      const awaits = last < 0 || thread.slice(last + 1).some((e) => !e.mine);
      if (awaits && this.aside.get(id) !== thread.length) result.add(id);
    }
    this.awaitingBefore = result;
    return result;
  }
}

/** NL1 to NL4 as written: an entry of another, after opening, is
 * unannounced until seen — watched, out of the list once all is judged,
 * told, or followed by one of mine. */
class Reference {
  private armed = false;
  private readonly unannounced = new Set<string>();

  appended(id: string, mine: boolean): void {
    if (mine) this.unannounced.delete(id);
    else if (this.armed) this.unannounced.add(id);
  }

  observe(
    world: World,
    awaiting: Set<string>,
    opening: boolean,
    settled: boolean,
    watched: boolean,
  ): string[] {
    if (!this.armed) {
      this.unannounced.clear();
      this.armed = !opening && settled;
      return [];
    }
    if (!settled) return [];
    const ids = watched
      ? []
      : [...world.threads.keys()].filter(
          (id) => this.unannounced.has(id) && awaiting.has(id),
        );
    this.unannounced.clear();
    return ids;
  }
}

type Step =
  | "entry"
  | "verify"
  | "set-aside"
  | "put-back"
  | "aside-and-back"
  | "nothing";

describe("awaiting alerts (property)", () => {
  test("NL1 to NL4: told exactly what the rules say, at each observation", () =>
    hegel.test(
      (tc) => {
        const world = new World();
        const reference = new Reference();
        const alerts = new AwaitingAlerts();
        let opening = true;
        /** The index tells of a change: the page, opening until its first
         * synchronization, then not. */
        const observe = () => {
          if (opening) opening = tc.draw(gs.booleans());
          const watched =
            tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0;
          const awaiting = world.awaiting();
          const settled = world.settled();
          const annotations = [...world.threads].map(([id, thread]) => ({
            id,
            replies: thread.slice(1),
          }));
          const expected = reference.observe(
            world,
            awaiting,
            opening,
            settled,
            watched,
          );
          const told = alerts.observe({
            annotations,
            awaiting,
            opening,
            settled,
            watched,
          });
          expect(told).toEqual(expected);
        };
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
        for (let i = 0; i < steps; i++) {
          const step = tc.draw(
            gs.sampledFrom<Step>([
              "entry",
              "entry",
              "verify",
              "set-aside",
              "put-back",
              "aside-and-back",
              "nothing",
            ]),
          );
          const id = tc.draw(gs.sampledFrom(IDS));
          if (step === "entry") {
            const mine = tc.draw(gs.booleans());
            // A verdict to come, at times.
            const late =
              tc.draw(gs.integers({ minValue: 0, maxValue: 7 })) === 0;
            const thread = world.threads.get(id) ?? [];
            thread.push({ mine, verified: !late });
            world.threads.set(id, thread);
            reference.appended(id, mine);
          } else if (step === "verify") {
            for (const thread of world.threads.values()) {
              for (const entry of thread) entry.verified = true;
            }
          } else if (step === "set-aside" || step === "aside-and-back") {
            const thread = world.threads.get(id);
            if (thread) world.aside.set(id, thread.length);
            // Set aside, seen so, then put back on another device: one
            // gesture, too long a sequence for chance.
            if (step === "aside-and-back") {
              observe();
              world.aside.delete(id);
            }
          } else if (step === "put-back") {
            world.aside.delete(id);
          }
          // Most changes are told.
          if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0) {
            observe();
          }
        }
      },
      { testCases: 400 },
    ));
});
