// The round of « Mes documents » (ADR-0060 §2; phase 34, NT2, NT4): the
// ten documents opened most recently, one at a time, when the list opens,
// then every 15 minutes while visible; nothing excluded, deleted or
// renewed; nothing after stopping.
import { describe, expect, test } from "vitest";
import type { KeyringEntry } from "../../lib/src/index.js";
import {
  ROUND_EVERY_MS,
  ROUND_SIZE,
  roundEntries,
  startAwaitingRound,
} from "./awaiting-round.js";

const entry = (n: number, more: Partial<KeyringEntry> = {}): KeyringEntry => ({
  documentId: `d${n}`,
  state: "ok",
  role: "edit",
  link: `https://x/?doc=d${n}`,
  title: null,
  openedAt: n,
  createdHere: false,
  excluded: false,
  ...more,
});

/** A round over `entries`, each count answered by the test. */
function harness(entries: KeyringEntry[]) {
  let now = 0;
  let visible = true;
  const timers: { at: number; run: () => void }[] = [];
  const visibleListeners = new Set<() => void>();
  const asked: { id: string; answer: (n: number | undefined) => void }[] = [];
  const shown: [string, number | undefined][] = [];
  const round = startAwaitingRound({
    entries: () => entries,
    count: (e) =>
      new Promise((resolve) =>
        asked.push({ id: e.documentId, answer: resolve }),
      ),
    shown: (id, n) => shown.push([id, n]),
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
  /** Answers every count, in turn, with `n`. */
  const answerAll = async (n: number) => {
    while (asked.length > 0) {
      asked.shift()?.answer(n);
      await flush();
    }
  };
  return {
    round,
    asked,
    shown,
    timers,
    flush,
    answerAll,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
      await flush();
    },
    setVisible: async (v: boolean) => {
      visible = v;
      for (const listener of visibleListeners) listener();
      await flush();
    },
  };
}

describe("the round of « Mes documents »", () => {
  test("the most recent ten, neither excluded nor deleted nor renewed", () => {
    const entries = [
      ...Array.from({ length: 14 }, (_, n) => entry(n)),
      entry(100, { excluded: true }),
      entry(101, { state: "deleted" }),
      entry(102, { state: "renewed" }),
      entry(103, { openedAt: null }),
    ];
    expect(roundEntries(entries).map((e) => e.documentId)).toEqual(
      Array.from({ length: ROUND_SIZE }, (_, n) => `d${13 - n}`),
    );
  });

  test("one at a time, each shown, then again after 15 minutes", async () => {
    const h = harness([entry(1), entry(2)]);
    await h.flush();
    expect(h.asked.map((a) => a.id)).toEqual(["d2"]);
    await h.answerAll(3);
    expect(h.shown).toEqual([
      ["d2", 3],
      ["d1", 3],
    ]);
    await h.advance(ROUND_EVERY_MS - 1);
    expect(h.asked).toEqual([]);
    await h.advance(1);
    expect(h.asked.map((a) => a.id)).toEqual(["d2"]);
  });

  test("hidden: the round stops after its document, and comes back once visible after 15 minutes", async () => {
    const h = harness([entry(1), entry(2)]);
    await h.flush();
    await h.setVisible(false);
    await h.answerAll(1);
    expect(h.shown).toEqual([["d2", 1]]);
    await h.advance(ROUND_EVERY_MS);
    expect(h.asked).toEqual([]);
    await h.setVisible(true);
    expect(h.asked.map((a) => a.id)).toEqual(["d2"]);
  });

  test("excluded during the round: not read", async () => {
    const entries = [entry(1), entry(2)];
    const h = harness(entries);
    await h.flush();
    entries[0] = entry(1, { excluded: true });
    await h.answerAll(0);
    expect(h.shown).toEqual([["d2", 0]]);
  });

  test("a count that fails: none shown for it, the next read", async () => {
    const h = harness([entry(1), entry(2)]);
    await h.flush();
    const first = h.asked.shift();
    first?.answer(undefined);
    await h.flush();
    expect(h.asked.map((a) => a.id)).toEqual(["d1"]);
  });

  test("stopped: nothing shown, nothing more asked", async () => {
    const h = harness([entry(1), entry(2)]);
    await h.flush();
    h.round.stop();
    await h.answerAll(5);
    expect(h.shown).toEqual([]);
    await h.advance(ROUND_EVERY_MS);
    expect(h.asked).toEqual([]);
  });
});
