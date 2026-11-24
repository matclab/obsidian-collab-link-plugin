import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  applyChangesToString,
  applyEditorChangesToLoroText,
  loroDeltaToChangeSpec,
} from "./binding.js";

describe("loroDeltaToChangeSpec", () => {
  test("a single insert op becomes a zero-width insert change", () => {
    const changes = loroDeltaToChangeSpec([{ retain: 3 }, { insert: "X" }]);

    expect(changes).toEqual([{ from: 3, to: 3, insert: "X" }]);
  });

  test("a single delete op becomes a range removal", () => {
    const changes = loroDeltaToChangeSpec([{ retain: 2 }, { delete: 3 }]);

    expect(changes).toEqual([{ from: 2, to: 5, insert: "" }]);
  });

  test("retain/delete/retain/insert composes into two changes with correctly offset positions", () => {
    const changes = loroDeltaToChangeSpec([
      { retain: 1 },
      { delete: 2 },
      { retain: 4 },
      { insert: "Z" },
    ]);

    expect(changes).toEqual([
      { from: 1, to: 3, insert: "" },
      { from: 7, to: 7, insert: "Z" },
    ]);
  });
});

describe("applyChangesToString", () => {
  test("applies a delta-derived change list to a plain string in document order", () => {
    const changes = loroDeltaToChangeSpec([
      { retain: 5 },
      { insert: " world" },
    ]);

    expect(applyChangesToString("Hello", changes)).toBe("Hello world");
  });

  test("applies multiple non-overlapping changes without corrupting later offsets", () => {
    const changes = loroDeltaToChangeSpec([
      { insert: "[A] " },
      { retain: 20 },
      { insert: " [B]" },
    ]);

    expect(applyChangesToString("The quick brown fox", changes)).toBe(
      "[A] The quick brown fox [B]",
    );
  });
});

describe("applyEditorChangesToLoroText", () => {
  test("a single insert edit matches applying it to the plain-string model", () => {
    const doc = new LoroDoc();
    const text = doc.getText("doc");
    text.insert(0, "Hello");
    const changes = [{ from: 5, to: 5, insert: " world" }];

    applyEditorChangesToLoroText(text, changes);

    expect(text.toString()).toBe(applyChangesToString("Hello", changes));
  });

  test("a batch of two non-overlapping edits (insert then delete, in document order) matches the plain-string model", () => {
    const base = "abcdefghij";
    const doc = new LoroDoc();
    const text = doc.getText("doc");
    text.insert(0, base);
    const changes = [
      { from: 2, to: 2, insert: "XY" },
      { from: 7, to: 9, insert: "" },
    ];

    applyEditorChangesToLoroText(text, changes);

    expect(text.toString()).toBe(applyChangesToString(base, changes));
  });
});
