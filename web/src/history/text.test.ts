import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  createAnnotation,
  listAnnotations,
} from "../../lib/src/annotations/model.js";
import { diffVersions, restoreText, textAt } from "./text.js";

function setUp() {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  const text = doc.getText("content");
  text.insert(0, "hello world");
  doc.commit();
  const v1 = doc.frontiers();
  text.delete(0, 6);
  text.insert(0, "brave new ");
  doc.commit();
  const v2 = doc.frontiers();
  return { doc, text, v1, v2 };
}

describe("textAt", () => {
  test("the text as it was at a version, the doc untouched", () => {
    const { doc, v1, v2 } = setUp();
    expect(textAt(doc, v1)).toBe("hello world");
    expect(textAt(doc, v2)).toBe("brave new world");
    expect(textAt(doc, [])).toBe("");
    expect(doc.getText("content").toString()).toBe("brave new world");
  });
});

describe("diffVersions", () => {
  test("what changed between two versions, removed text included", () => {
    const { doc, v1, v2 } = setUp();
    expect(diffVersions(doc, v1, v2)).toEqual([
      { kind: "removed", text: "hello " },
      { kind: "added", text: "brave new " },
      { kind: "same", text: "world" },
    ]);
  });

  test("no change: one run of the same text", () => {
    const { doc, v2 } = setUp();
    expect(diffVersions(doc, v2, v2)).toEqual([
      { kind: "same", text: "brave new world" },
    ]);
  });
});

describe("restoreText", () => {
  test("brings the text back as new operations, with a message", () => {
    const { doc, text, v1 } = setUp();
    const before = doc.oplogVersion();
    expect(restoreText(doc, v1, "restored from v1")).toBe(true);
    expect(text.toString()).toBe("hello world");
    // New operations: the history is intact, later versions still there.
    expect(doc.oplogVersion().compare(before)).toBe(1);
    const peer = doc.peerIdStr;
    const changes = doc.getAllChanges().get(peer) ?? [];
    expect(changes.at(-1)?.message).toBe("restored from v1");
  });

  test("restoring the current version changes nothing", () => {
    const { doc, v2 } = setUp();
    const before = doc.oplogVersion();
    expect(restoreText(doc, v2, "no-op")).toBe(false);
    expect(doc.oplogVersion().compare(before)).toBe(0);
  });

  test("the same text by other operations: nothing to restore, nothing written", () => {
    const { doc, text } = setUp();
    const v = doc.frontiers();
    text.delete(0, 5);
    text.insert(0, "brave"); // deleted and typed again: same text, new ops
    doc.commit();
    const before = doc.oplogVersion();
    expect(restoreText(doc, v, "no-op")).toBe(false);
    expect(doc.oplogVersion().compare(before)).toBe(0);
  });

  test("text that didn't change keeps its identity: an annotation on it keeps its range", () => {
    const { doc, text, v2 } = setUp(); // "brave new world"
    const annotations = new LoroDoc();
    const id = createAnnotation(doc, annotations, {
      type: "comment",
      start: 10,
      end: 15,
      author: "a",
      body: "on world",
    });
    text.delete(0, 5);
    text.insert(0, "bold");
    doc.commit();
    restoreText(doc, v2, "restored");
    expect(text.toString()).toBe("brave new world");
    const range = listAnnotations(doc, annotations).find(
      (a) => a.id === id,
    )?.range;
    expect(range).toEqual({ start: 10, end: 15 });
  });
});
