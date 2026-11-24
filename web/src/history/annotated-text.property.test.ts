import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { type Change, LoroDoc, type PeerID, VersionVector } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type RangeAnchor,
  anchorRange,
  resolveRange,
} from "../../lib/src/annotations/anchor.js";
import { counter, resetCounters } from "../perf/index.js";
import { annotatedText } from "./annotated-text.js";
import { causalOrder } from "./versions.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** A random history on one or two pages, typing and deleting, syncing now
 * and then, with an annotation anchored at a drawn moment on a drawn
 * range. Returns the first page, every change synced. */
function history(tc: TC) {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 2 }));
  const pages = Array.from({ length: count }, (_, i) => {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(i + 1));
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(0);
    return { doc, clock: 1000 };
  });
  const sync = (from: LoroDoc, to: LoroDoc) =>
    to.import(from.export({ mode: "update", from: to.oplogVersion() }));
  let anchor: RangeAnchor | undefined;
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let step = 0; step < steps; step++) {
    const page = pages[
      tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }))
    ] as (typeof pages)[number];
    const text = page.doc.getText("content");
    if (!anchor && text.length > 0 && tc.draw(gs.booleans())) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: text.length - 1 }),
      );
      const end = tc.draw(
        gs.integers({ minValue: at + 1, maxValue: text.length }),
      );
      anchor = anchorRange(text, at, end);
    }
    if (text.length > 0 && tc.draw(gs.booleans())) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: text.length - 1 }),
      );
      const length = tc.draw(
        gs.integers({ minValue: 1, maxValue: text.length - at }),
      );
      text.delete(at, length);
    } else {
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
      text.insert(at, tc.draw(gs.sampledFrom(["a", "bc", "def"])));
    }
    page.clock += tc.draw(gs.integers({ minValue: 0, maxValue: 100 }));
    page.doc.setNextCommitTimestamp(page.clock);
    page.doc.commit();
    if (count > 1 && tc.draw(gs.booleans())) {
      const other =
        pages[tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }))];
      if (other && other !== page) sync(page.doc, other.doc);
    }
  }
  for (const a of pages) for (const b of pages) if (a !== b) sync(a.doc, b.doc);
  const [first] = pages;
  if (!first) throw new Error("no page");
  return { doc: first.doc, anchor };
}

/** The model: the text the range covers after each prefix of the
 * changes, 0 to N, each on its own copy; and the first prefix holding
 * both its characters. */
function scan(doc: LoroDoc, changes: Change[], anchor: RangeAnchor) {
  const covered: (string | undefined)[] = [];
  let holding: number | undefined;
  const reached = new Map<PeerID, number>();
  const held = (pos: ReturnType<RangeAnchor["startCursor"]["pos"]>) =>
    pos !== undefined && (reached.get(pos.peer) ?? 0) > pos.counter;
  for (let length = 0; length <= changes.length; length++) {
    const change = changes[length - 1];
    if (change) reached.set(change.peer, change.counter + change.length);
    if (
      holding === undefined &&
      held(anchor.startCursor.pos()) &&
      held(anchor.endCursor.pos())
    ) {
      holding = length;
    }
    const fork = doc.forkAt(doc.vvToFrontiers(new VersionVector(reached)));
    const range = resolveRange(fork, anchor);
    covered.push(
      range && range.end > range.start
        ? fork.getText("content").toString().slice(range.start, range.end)
        : undefined,
    );
    fork.free();
  }
  return { covered, holding };
}

/** The property: on a random history (`tc`), or a counter-example's
 * replay. */
const property = (tc: TC): void => {
  const { doc, anchor } = history(tc);
  if (!anchor) return;
  const changes = causalOrder(doc);
  const version = doc.oplogVersion();
  const before = doc.getText("content").toString();

  resetCounters();
  const result = annotatedText(doc, anchor);
  const copies = counter("annotations.textThen");

  expect(doc.oplogVersion().compare(version)).toBe(0);
  expect(doc.getText("content").toString()).toBe(before);
  expect(copies).toBeLessThanOrEqual(
    Math.ceil(Math.log2(Math.max(changes.length, 1))) + 1,
  );

  const { covered, holding } = scan(doc, changes, anchor);
  const now = covered[changes.length];
  if (now !== undefined) {
    expect(result).toEqual({ kind: "now", text: now });
    expect(copies).toBe(0);
    return;
  }
  // The boundaries: a prefix covering, the next one not.
  const boundaries = covered.flatMap((text, i) =>
    text !== undefined && covered[i + 1] === undefined ? [i] : [],
  );
  const covering = covered.flatMap((text, i) =>
    text === undefined ? [] : [i],
  );
  // Monotone: covering from the first prefix holding both characters,
  // then never again. Otherwise (its characters typed and deleted in one
  // change, text typed between its deleted cursors), any boundary.
  const monotone =
    covering.length === 0 ||
    (covering[0] === holding &&
      covering.every(
        (i, k) => k === 0 || i === (covering[k - 1] as number) + 1,
      ));
  if (result.kind === "then") {
    const found = boundaries.filter((i) => {
      const change = changes[i] as Change;
      return (
        covered[i] === result.text &&
        change.peer === result.deletedBy &&
        change.timestamp === result.deletedAt
      );
    });
    expect(found.length).toBeGreaterThan(0);
    if (monotone) expect(found).toContain(boundaries.at(-1));
  } else {
    expect(result).toEqual({ kind: "unavailable" });
    if (monotone) expect(covering).toEqual([]);
  }
};

function replay(draws: readonly (number | boolean | string)[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("the text an annotation covered, property (ADR-0052 §4)", () => {
  test(
    "a boundary of the history, the last one when covering is monotone; nothing changed; copies under the bound",
    () => hegel.test(property, { testCases: 400 }),
    60_000,
  );

  // Found on 2026-11-08 when first run, a fault of the model, not of the
  // search: the first page's commits at one date are one change, that
  // types « aa », anchors it and deletes it; the range covers text only
  // once the second page types between its deleted cursors. The model
  // called that monotone (one run of prefixes covering); the search,
  // starting at the first prefix holding both characters, finds it
  // unavailable — the case the plan admits (analysis 26a).
  test("replay: covering only at one prefix, both pages at one date", () => {
    const { tc, done } = replay([
      2,
      8,
      0,
      0,
      "a",
      0,
      false,
      1,
      0,
      "a",
      0,
      false,
      0,
      false,
      false,
      0,
      "a",
      0,
      false,
      0,
      true,
      0,
      2,
      true,
      1,
      1,
      0,
      true,
      1,
      0,
      true,
      0,
      1,
      0,
      false,
      1,
      false,
      1,
      "a",
      0,
      false,
      1,
      true,
      0,
      1,
      0,
      false,
      1,
      true,
      0,
      1,
      1,
      false,
    ]);
    property(tc);
    expect(done()).toBe(true);
  });
});
