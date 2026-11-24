// Cursors come from other peers (annotation anchors, presence): one that
// `Cursor.decode` accepts can still make `getCursorPos` trap and poison the
// document it is resolved on (docs/phase-9-durcissement.md, analysis
// 9c.1). `resolveCursor` resolves only a cursor on `content` at an op the
// document holds (docs/protocol/03-document.md, D-37).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Cursor, LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { resolveCursor } from "./cursor.js";
import { counter, resetCounters } from "./perf/index.js";

function hello(): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  doc.getText("content").insert(0, "hello");
  doc.commit();
  return doc;
}

/** The document is still usable: what a trap leaves broken. */
function usable(doc: LoroDoc): void {
  doc.export({ mode: "snapshot" });
  doc.getText("content").insert(0, "x");
  doc.commit();
}

/** A legitimate cursor at 2 whose counter is changed to -1: the third byte
 * is the counter, a zigzag varint (`04` = 2, `01` = -1). */
function negativeCounter(doc: LoroDoc): Uint8Array {
  const bytes = doc.getText("content").getCursor(2)?.encode();
  if (!bytes) throw new Error("no cursor");
  const hostile = Uint8Array.from(bytes);
  hostile[2] = 0x01;
  return hostile;
}

describe("resolveCursor", () => {
  test("resolves a legitimate cursor as getCursorPos does", () => {
    const doc = hello();
    const text = doc.getText("content");
    for (let at = 0; at <= text.length; at++) {
      const cursor = text.getCursor(at);
      if (!cursor) continue;
      expect(resolveCursor(doc, cursor)).toEqual(doc.getCursorPos(cursor));
    }
  });

  test("leaves unresolved, without trapping, a cursor at a negative counter", () => {
    const doc = hello();
    const cursor = Cursor.decode(negativeCounter(doc));
    expect(cursor.pos()).toEqual({ peer: "1", counter: -1 });

    expect(resolveCursor(doc, cursor)).toBeUndefined();
    usable(doc);
  });

  test("leaves unresolved a cursor at an op the document doesn't hold yet", () => {
    const later = hello();
    const cursor = later.getText("content").getCursor(2);
    if (!cursor) throw new Error("no cursor");
    const empty = new LoroDoc();

    expect(resolveCursor(empty, cursor)).toBeUndefined();
    usable(empty);
  });

  test("leaves unresolved a cursor on another container", () => {
    const doc = hello();
    doc.getText("other").insert(0, "abc");
    doc.commit();
    const cursor = doc.getText("other").getCursor(1);
    if (!cursor) throw new Error("no cursor");

    expect(resolveCursor(doc, cursor)).toBeUndefined();
  });

  test("takes the version it compares with, read once by a caller resolving many", () => {
    const doc = hello();
    const cursor = doc.getText("content").getCursor(2);
    if (!cursor) throw new Error("no cursor");
    const before = new LoroDoc().oplogVersion();

    expect(resolveCursor(doc, cursor, before)).toBeUndefined();
    expect(resolveCursor(doc, cursor, doc.oplogVersion())?.offset).toBe(2);
  });
});

describe("a cursor whose character was deleted, for display (phase 9, E3)", () => {
  // Loro resolves it by walking the history (44 ms on the usage profile,
  // 0.9 s on a year of it), and offers in `update` a cursor on a living
  // character, resolved in microseconds: kept, the walk is paid once.
  test("is resolved the slow way once, then by its update, at the same place", () => {
    const doc = hello();
    const text = doc.getText("content");
    const cursor = text.getCursor(2) as Cursor;
    text.delete(1, 3); // "ho": the cursor's character is gone
    doc.commit();
    resetCounters();
    const first = resolveCursor(doc, cursor, undefined, true)?.offset;
    text.insert(0, "abc");
    doc.commit();
    const second = resolveCursor(doc, cursor, undefined, true)?.offset;
    expect(first).toBe(1);
    expect(second).toBe(doc.getCursorPos(cursor)?.offset);
    // Still told that the character is gone: a range's end reads it (D-13).
    expect(resolveCursor(doc, cursor, undefined, true)?.update).toBeDefined();
    expect(counter("cursor.slow")).toBe(1);
  });

  test("an update that names no character (the text emptied) is not kept", () => {
    const doc = hello();
    const text = doc.getText("content");
    const cursor = text.getCursor(2) as Cursor;
    text.delete(0, 5);
    doc.commit();
    resetCounters();
    resolveCursor(doc, cursor, undefined, true);
    resolveCursor(doc, cursor, undefined, true);
    expect(counter("cursor.slow")).toBe(2);
  });

  // Found by the multi-peer property: an update kept while an insertion
  // concurrent with the deletion is still on its way no longer resolves
  // as the cursor does once it arrives. Kept for display only; by default
  // (decision effects, export, the library's listAnnotations) exact.
  test("by default, exact: what display kept is not used", () => {
    const a = new LoroDoc();
    a.setPeerId(1n);
    a.getText("content").insert(0, "abc");
    a.commit();
    const b = new LoroDoc();
    b.setPeerId(2n);
    b.import(a.export({ mode: "snapshot" }));
    const cursor = a.getText("content").getCursor(1) as Cursor; // on "b"
    b.getText("content").insert(2, "X"); // concurrently, right after "b"
    b.commit();
    a.getText("content").delete(1, 1);
    a.commit();
    resolveCursor(a, cursor, undefined, true); // display keeps an update
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    expect(a.getText("content").toString()).toBe("aXc");
    expect(a.getCursorPos(cursor)?.offset).toBe(1);
    expect(resolveCursor(a, cursor)?.offset).toBe(1);
    // What display shows, until the page reloads: one character off.
    expect(resolveCursor(a, cursor, undefined, true)?.offset).toBe(2);
  });
});

describe("any cursor a peer could publish (property, D-37)", () => {
  test("never throws, never breaks the document, and agrees with getCursorPos on legitimate ones", () =>
    hegel.test(
      (tc) => {
        const doc = hello();
        const text = doc.getText("content");
        const words = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        for (let i = 0; i < words; i++) {
          text.insert(
            tc.draw(gs.integers({ minValue: 0, maxValue: text.length })),
            "ab",
          );
          doc.commit();
        }
        const at = tc.draw(
          gs.integers({ minValue: 0, maxValue: text.length - 1 }),
        );
        const legit = text.getCursor(at)?.encode() ?? new Uint8Array();
        let bytes: Uint8Array;
        if (tc.draw(gs.booleans())) {
          bytes = new Uint8Array(
            tc.draw(gs.binary({ minSize: 0, maxSize: 40 })),
          );
        } else {
          bytes = Uint8Array.from(legit);
          const changes = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
          for (let i = 0; i < changes && bytes.length > 0; i++) {
            const index = tc.draw(
              gs.integers({ minValue: 0, maxValue: bytes.length - 1 }),
            );
            bytes[index] = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
          }
        }
        let cursor: Cursor;
        try {
          cursor = Cursor.decode(bytes);
        } catch {
          return; // refused before resolving: nothing to resolve
        }
        const intact =
          bytes.length === legit.length &&
          bytes.every((b, i) => b === legit[i]);
        // Only an intact cursor is safe to hand to getCursorPos itself.
        const expected = intact ? doc.getCursorPos(cursor) : undefined;
        const resolved = resolveCursor(doc, cursor);
        if (intact) expect(resolved).toEqual(expected);
        usable(doc);
      },
      { testCases: 400 },
    ));
});
