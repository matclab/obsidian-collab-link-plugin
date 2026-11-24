import { LoroDoc } from "loro-crdt";
import { beforeEach, describe, expect, test } from "vitest";
import { anchorRange } from "../../lib/src/annotations/anchor.js";
import { counter, resetCounters } from "../perf/index.js";
import { annotatedText, annotatedTextAt } from "./annotated-text.js";

function page(peer: number) {
  const doc = new LoroDoc();
  doc.setPeerId(BigInt(peer));
  doc.setRecordTimestamp(true);
  return doc;
}

function edit(
  doc: LoroDoc,
  at: number,
  run: (text: ReturnType<LoroDoc["getText"]>) => void,
) {
  run(doc.getText("content"));
  doc.setNextCommitTimestamp(at);
  doc.commit();
}

function anchorOn(doc: LoroDoc, start: number, end: number) {
  const anchor = anchorRange(doc.getText("content"), start, end);
  if (!anchor) throw new Error("no anchor");
  return anchor;
}

beforeEach(() => resetCounters());

describe("the text an annotation covers (ADR-0052 §4)", () => {
  test("TA1: text left in its range is today's, without a copy", () => {
    const doc = page(1);
    edit(doc, 1000, (text) => text.insert(0, "hello world"));
    const anchor = anchorOn(doc, 6, 11);
    edit(doc, 1100, (text) => text.delete(6, 2));

    expect(annotatedText(doc, anchor)).toEqual({ kind: "now", text: "rld" });
    expect(counter("annotations.textThen")).toBe(0);
  });

  test("TA2: its text deleted, the last text it covered, and who emptied it, when", () => {
    const alice = page(1);
    edit(alice, 1000, (text) => text.insert(0, "hello world"));
    const anchor = anchorOn(alice, 6, 11);
    edit(alice, 1100, (text) => text.insert(11, "!"));
    edit(alice, 1200, (text) => text.delete(6, 3)); // "wor" goes, "ld" left
    const bob = page(2);
    bob.import(alice.export({ mode: "update" }));
    edit(bob, 1300, (text) => text.delete(6, 2)); // "ld" goes
    edit(bob, 1400, (text) => text.insert(0, ">> "));
    const version = bob.oplogVersion();

    expect(annotatedText(bob, anchor)).toEqual({
      kind: "then",
      text: "ld",
      deletedBy: "2",
      deletedAt: 1300,
    });
    expect(bob.getText("content").toString()).toBe(">> hello !");
    expect(bob.oplogVersion().compare(version)).toBe(0);
  });

  test("TA5: a range never seen covering text, or a change not received", () => {
    const alice = page(1);
    edit(alice, 1000, (text) => text.insert(0, "hello"));
    const anchor = anchorOn(alice, 0, 5);
    const bob = page(2);
    edit(bob, 1000, (text) => text.insert(0, "other"));
    expect(annotatedText(bob, anchor)).toEqual({ kind: "unavailable" });

    // A point: an addition's range, never covering text.
    const point = anchorOn(alice, 2, 2);
    expect(annotatedText(alice, point)).toEqual({ kind: "unavailable" });
  });

  test("TA4: at most ⌈log₂ N⌉ + 1 copies, N the content's changes", () => {
    const doc = page(1);
    doc.setChangeMergeInterval(0);
    edit(doc, 1000, (text) => text.insert(0, "target "));
    const anchor = anchorOn(doc, 0, 6);
    // One change a second: none merged.
    for (let i = 1; i <= 1000; i++) {
      edit(doc, 1000 + i, (text) => text.insert(text.length, "x"));
    }
    edit(doc, 2001, (text) => text.delete(0, 6));
    for (let i = 1; i <= 1000; i++) {
      edit(doc, 2001 + i, (text) => text.insert(text.length, "y"));
    }
    const changes = [...doc.getAllChanges().values()].flat().length;

    expect(annotatedText(doc, anchor)).toMatchObject({
      kind: "then",
      text: "target",
      deletedAt: 2001,
    });
    expect(changes).toBe(2002);
    expect(counter("annotations.textThen")).toBeLessThanOrEqual(
      Math.ceil(Math.log2(changes)) + 1,
    );
  });
});

describe("where it stands today (phase 27)", () => {
  test("its range resolved once: the passage, the point where its text was, or nowhere", () => {
    const alice = page(1);
    edit(alice, 1000, (text) => text.insert(0, "hello world"));
    const anchor = anchorOn(alice, 6, 11);
    expect(annotatedTextAt(alice, anchor)).toEqual({
      text: { kind: "now", text: "world" },
      at: { start: 6, end: 11 },
    });
    expect(counter("cursor.resolve")).toBe(2);

    edit(alice, 2000, (text) => text.delete(5, 6));
    expect(annotatedTextAt(alice, anchor).at).toEqual({ start: 5, end: 5 });

    const bob = page(2);
    edit(bob, 1000, (text) => text.insert(0, "other"));
    expect(annotatedTextAt(bob, anchor)).toEqual({
      text: { kind: "unavailable" },
      at: undefined,
    });
  });
});
