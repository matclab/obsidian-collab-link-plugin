// The round of « Mes documents » under a controlled order (AGENTS.md §1.6;
// phase 34, analysis 34 ter): each count ends when Hegel says, with a
// number, nothing or an error; the page hidden or shown; the time moved on,
// a little or past 15 minutes; a document excluded, deleted or opened
// meanwhile; the round stopped.
//
// At every step: at most one count at a time, none started while hidden,
// none after stopping (NT4); none for a document excluded, deleted or
// renewed when it starts, at most ten per round (NT2); what is shown is
// what the count found, nothing after stopping. Visible, idle, 15 minutes
// after a round: the next has started.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import type { KeyringEntry } from "../../lib/src/index.js";
import {
  ROUND_EVERY_MS,
  ROUND_SIZE,
  roundEntries,
  startAwaitingRound,
} from "./awaiting-round.js";

describe("the round of « Mes documents » (controlled order)", () => {
  test("one at a time, visible, never excluded, ten a round, nothing after stopping", () =>
    hegel.testAsync(
      async (tc) => {
        const size = tc.draw(gs.integers({ minValue: 0, maxValue: 14 }));
        const entries: KeyringEntry[] = Array.from(
          { length: size },
          (_, n) => ({
            documentId: `d${n}`,
            state: "ok",
            role: "edit",
            link: `https://x/?doc=d${n}`,
            title: null,
            openedAt: tc.draw(gs.integers({ minValue: 0, maxValue: 5 })),
            createdHere: false,
            excluded: false,
          }),
        );
        let now = 0;
        // Noted where the round calls, thrown by the test: the round
        // catches what a count throws.
        const problems: string[] = [];
        const fail = (why: string) => void problems.push(why);
        let visible = tc.draw(gs.booleans());
        let stopped = false;
        const timers: { at: number; run: () => void }[] = [];
        const visibleListeners = new Set<() => void>();
        let inFlight:
          | { id: string; settle: (n: number | undefined | Error) => void }
          | undefined;
        /** Counts started since a round could last start. */
        let sinceStart = 0;
        let answered: number | undefined;
        let answeredId: string | undefined;
        const round = startAwaitingRound({
          entries: () => entries,
          count: (entry) => {
            if (stopped) fail("NT4: a count after stopping");
            if (!visible) fail("NT4: a count started hidden");
            if (inFlight) fail("NT4: two counts at a time");
            const now = entries.find((e) => e.documentId === entry.documentId);
            if (!now || now.excluded || now.state !== "ok") {
              fail(`NT2: ${entry.documentId} counted, ${JSON.stringify(now)}`);
            }
            sinceStart++;
            if (sinceStart > ROUND_SIZE) fail("NT2: more than ten a round");
            return new Promise((resolve, reject) => {
              inFlight = {
                id: entry.documentId,
                settle: (n) => (n instanceof Error ? reject(n) : resolve(n)),
              };
            });
          },
          shown: (id, n) => {
            if (stopped) fail("NT4: shown after stopping");
            if (id !== answeredId || n !== answered) {
              fail(`shown ${id} ${n}, answered ${answeredId} ${answered}`);
            }
          },
          visible: () => visible,
          onVisible: (listener) => {
            visibleListeners.add(listener);
            return () => visibleListeners.delete(listener);
          },
          setTimer: (run, ms) => {
            const timer = { at: now + ms, run };
            timers.push(timer);
            return () => {
              const at = timers.indexOf(timer);
              if (at >= 0) timers.splice(at, 1);
            };
          },
          now: () => now,
        });
        const flush = async () => {
          // Every microtask run, however long its chain: a macrotask comes after.
          await new Promise((resolve) => setTimeout(resolve, 0));
        };
        await flush();
        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
        for (let step = 0; step < steps; step++) {
          const move = tc.draw(
            gs.sampledFrom([
              ...(inFlight ? ["answer", "answer", "answer", "fail"] : []),
              "visible",
              "later",
              "much-later",
              ...(entries.length > 0 ? ["exclude", "delete", "open"] : []),
              ...(stopped ? [] : ["stop"]),
            ]),
          );
          if (move === "answer" || move === "fail") {
            // -1: the count found nothing.
            const drawn = tc.draw(gs.integers({ minValue: -1, maxValue: 3 }));
            const n = move === "fail" || drawn < 0 ? undefined : drawn;
            const settling = inFlight;
            inFlight = undefined;
            answered = n;
            answeredId = settling?.id;
            settling?.settle(move === "fail" ? new Error("no") : n);
          } else if (move === "visible") {
            visible = !visible;
            if (visible) sinceStart = 0;
            for (const listener of [...visibleListeners]) listener();
          } else if (move === "later" || move === "much-later") {
            now += move === "later" ? 60_000 : ROUND_EVERY_MS;
            const due = timers.filter((t) => t.at <= now);
            if (due.length > 0) sinceStart = 0;
            for (const timer of due) {
              timers.splice(timers.indexOf(timer), 1);
              timer.run();
            }
          } else if (
            move === "exclude" ||
            move === "delete" ||
            move === "open"
          ) {
            const at = tc.draw(
              gs.integers({ minValue: 0, maxValue: entries.length - 1 }),
            );
            const was = entries[at] as KeyringEntry;
            entries[at] =
              move === "exclude"
                ? { ...was, excluded: true }
                : move === "delete"
                  ? { ...was, state: "deleted" }
                  : { ...was, openedAt: now + 10 };
          } else if (move === "stop") {
            round.stop();
            stopped = true;
          }
          await flush();
          if (problems.length > 0) throw new Error(problems.join("; "));
          // Visible, idle, a round ended 15 minutes ago or more: one runs.
          if (
            move === "much-later" &&
            visible &&
            !stopped &&
            !inFlight &&
            roundEntries(entries).length > 0 &&
            timers.length > 0
          ) {
            fail("visible, idle, 15 minutes past a round: none started");
          }
        }
        round.stop();
        stopped = true;
        inFlight?.settle(1);
        await flush();
        if (problems.length > 0) throw new Error(problems.join("; "));
      },
      { testCases: 400 },
    ));
});
