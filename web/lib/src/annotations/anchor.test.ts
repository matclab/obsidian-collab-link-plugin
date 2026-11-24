import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { anchorRange, resolveRange } from "./anchor.js";

describe("anchorRange / resolveRange", () => {
  test("resolves back to the same substring right after anchoring", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "hello world");
    doc.commit();

    const anchor = anchorRange(doc.getText("content"), 0, 5);
    expect(anchor).toBeDefined();
    const resolved = resolveRange(doc, anchor as NonNullable<typeof anchor>);

    expect(resolved).toEqual({ start: 0, end: 5 });
  });

  // Empirically checked (node -e against loro-crdt@1.16): a Cursor anchored
  // inside text that is later entirely deleted does NOT become unresolvable
  // — getCursorPos still finds it (Loro keeps tombstones), collapsed to a
  // zero-width range at the position the text used to occupy. `null` is
  // reserved for a genuinely foreign cursor (below), not "deleted" — the
  // plan doc's assumption of `null` for the deleted case doesn't hold.
  test("collapses to a zero-width range once the anchored text has been entirely deleted", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "hello world");
    doc.commit();

    const anchor = anchorRange(doc.getText("content"), 0, 5);
    doc.getText("content").delete(0, 5);
    doc.commit();

    const resolved = resolveRange(doc, anchor as NonNullable<typeof anchor>);
    expect(resolved).toEqual({ start: 0, end: 0 });
  });

  test("returns null for a cursor referencing an op this doc never imported", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "hello world");
    doc.commit();

    const foreign = new LoroDoc();
    foreign.getText("content").insert(0, "xyz");
    foreign.commit();
    const foreignAnchor = {
      startCursor: foreign.getText("content").getCursor(0, 0),
      endCursor: foreign.getText("content").getCursor(1, 0),
    } as NonNullable<ReturnType<typeof anchorRange>>;

    expect(resolveRange(doc, foreignAnchor)).toBeNull();
  });

  // ADR-0014 (supersedes ADR-0003 on this point): text inserted at either
  // boundary of an anchored range stays outside it — a suggested addition
  // right after a suggested deletion must not end up deleted with it.
  describe("insertions at the boundaries stay outside, inside ones extend (ADR-0014)", () => {
    function setUp() {
      const doc = new LoroDoc();
      doc.setPeerId(1n);
      doc.getText("content").insert(0, "hello world");
      doc.commit();
      const anchor = anchorRange(doc.getText("content"), 6, 11); // "world"
      if (!anchor) throw new Error("no anchor");
      return { doc, anchor, text: doc.getText("content") };
    }
    const slice = (doc: LoroDoc, r: { start: number; end: number } | null) =>
      r && doc.getText("content").toString().slice(r.start, r.end);

    test("at the end boundary", () => {
      const { doc, anchor, text } = setUp();
      text.insert(11, "!!!");
      doc.commit();
      expect(slice(doc, resolveRange(doc, anchor))).toBe("world");
    });

    test("at the start boundary", () => {
      const { doc, anchor, text } = setUp();
      text.insert(6, "big ");
      doc.commit();
      expect(slice(doc, resolveRange(doc, anchor))).toBe("world");
    });

    test("strictly inside, the range grows", () => {
      const { doc, anchor, text } = setUp();
      text.insert(8, "XX");
      doc.commit();
      expect(slice(doc, resolveRange(doc, anchor))).toBe("woXXrld");
    });

    test("from another peer at the end boundary, on both peers", () => {
      const { doc, anchor } = setUp();
      const other = new LoroDoc();
      other.setPeerId(2n);
      other.import(doc.export({ mode: "update" }));
      other.getText("content").insert(11, "!!!");
      other.commit();
      doc.import(other.export({ mode: "update" }));
      expect(slice(doc, resolveRange(doc, anchor))).toBe("world");
      expect(slice(other, resolveRange(other, anchor))).toBe("world");
    });

    test("when its last character is deleted, the range ends after what remains", () => {
      const { doc, anchor, text } = setUp();
      text.delete(10, 1); // "worl"
      doc.commit();
      expect(slice(doc, resolveRange(doc, anchor))).toBe("worl");
    });

    test("a zero-width range stays a point", () => {
      const doc = new LoroDoc();
      doc.getText("content").insert(0, "hello world");
      doc.commit();
      const anchor = anchorRange(doc.getText("content"), 5, 5);
      if (!anchor) throw new Error("no anchor");
      expect(resolveRange(doc, anchor)).toEqual({ start: 5, end: 5 });
    });

    test("an anchor made before ADR-0014 (end on the next character) still resolves as it did", () => {
      const { doc, text } = setUp();
      const legacy = {
        startCursor: text.getCursor(6, 0),
        endCursor: text.getCursor(11, 0),
      } as NonNullable<ReturnType<typeof anchorRange>>;
      text.insert(11, "!!!");
      doc.commit();
      expect(slice(doc, resolveRange(doc, legacy))).toBe("world!!!");
    });
  });
});
