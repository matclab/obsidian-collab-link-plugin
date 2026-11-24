import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { resolveRange } from "./anchor.js";
import {
  annotationAnchor,
  createAnnotation,
  listAnnotations,
  tryCreateAnnotation,
  updateStatus,
} from "./model.js";

function makeDocs() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "hello world");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  return { contentDoc, annotationsDoc };
}

describe("createAnnotation / listAnnotations", () => {
  test("a created annotation appears in listAnnotations with its resolved range", () => {
    const { contentDoc, annotationsDoc } = makeDocs();

    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "needs work",
    });

    const annotations = listAnnotations(contentDoc, annotationsDoc);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      type: "comment",
      author: "alice",
      body: "needs work",
      status: "open",
      range: { start: 0, end: 5 },
    });
  });

  test("updateStatus changes only the status, never the anchor or the author", () => {
    const { contentDoc, annotationsDoc } = makeDocs();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 0,
      end: 5,
      author: "alice",
    });

    updateStatus(annotationsDoc, id, "accepted");

    const [annotation] = listAnnotations(contentDoc, annotationsDoc);
    expect(annotation).toMatchObject({
      id,
      status: "accepted",
      author: "alice",
      range: { start: 0, end: 5 },
    });
  });
});

describe("tryCreateAnnotation", () => {
  test("creates the annotation and returns its id when the range doesn't cross anything existing", () => {
    const { contentDoc, annotationsDoc } = makeDocs();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "x",
    });

    const result = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 6,
      end: 11,
      author: "bob",
      body: "y",
    });

    expect(result.ok).toBe(true);
    expect(listAnnotations(contentDoc, annotationsDoc)).toHaveLength(2);
  });

  test("refuses and writes nothing when the range would cross an existing annotation (ADR-0012 layer 1)", () => {
    const { contentDoc, annotationsDoc } = makeDocs();
    const existingId = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "alice",
      body: "x",
    });

    const result = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 5,
      end: 11,
      author: "bob",
      body: "y",
    });

    expect(result).toEqual({ ok: false, conflictWith: existingId });
    expect(listAnnotations(contentDoc, annotationsDoc)).toHaveLength(1);
  });

  test("does not refuse against an existing annotation that's no longer open (ADR-0012 'active' scope)", () => {
    const { contentDoc, annotationsDoc } = makeDocs();
    const closedId = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "alice",
      body: "x",
    });
    updateStatus(annotationsDoc, closedId, "resolved");

    const result = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 5,
      end: 11,
      author: "bob",
      body: "y",
    });

    expect(result.ok).toBe(true);
  });
});

describe("annotationAnchor", () => {
  test("the anchor of an annotation, whatever its status; nothing for an unknown id", () => {
    const { contentDoc, annotationsDoc } = makeDocs();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 6,
      end: 11,
      author: "alice",
    });
    updateStatus(annotationsDoc, id, "resolved");

    const anchor = annotationAnchor(annotationsDoc, id);
    expect(anchor && resolveRange(contentDoc, anchor)).toEqual({
      start: 6,
      end: 11,
    });
    expect(annotationAnchor(annotationsDoc, "unknown")).toBeUndefined();
  });
});
