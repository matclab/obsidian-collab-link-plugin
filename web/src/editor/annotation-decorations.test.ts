// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  AnnotationIndex,
  createAnnotation,
  suggestAddition,
  tryCreateAnnotation,
  updateStatus,
} from "../../lib/src/annotations/index.js";
import { ActiveAnnotation } from "../view-model/active-annotation.js";
import { attachAnnotationDecorations } from "./annotation-decorations.js";
import { createDocumentEditor } from "./editor.js";

/** A primary button's press and release at `x`, on `target`. */
const press = (target: Element | null, x: number) =>
  target?.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x }),
  );
const release = (target: Element | null, x: number) =>
  target?.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: x }),
  );

// What jsdom lacks: the boxes CodeMirror measures to find a press's
// position (multi-click.ts), reached once the text has its inset.
const saved = {
  rangeRects: Range.prototype.getClientRects,
  rangeBox: Range.prototype.getBoundingClientRect,
};
beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Range.prototype.getClientRects = saved.rangeRects;
  Range.prototype.getBoundingClientRect = saved.rangeBox;
});

/** The index notifies its readers in a microtask. */
const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setUp(text = "hello world") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const parent = document.createElement("div");
  const editor = createDocumentEditor(parent, contentDoc);
  return { contentDoc, annotationsDoc, editor };
}

describe("attachAnnotationDecorations", () => {
  test("a pending addition shows its proposed text as a widget where it would land (ADR-0018)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const widget = editor.view.dom.querySelector(".cm-annotation-addition");
    expect(widget?.textContent).toBe(" dear");
    expect(editor.view.state.doc.toString()).toBe("hello world");
    // Right after "hello": the widget sits between the two words.
    expect(editor.view.dom.querySelector(".cm-line")?.textContent).toBe(
      "hello dear world",
    );
  });

  test("a proposed paragraph before a heading is drawn as a block of its own, not in the heading's line (phase 24)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp("Para.\n\n### Title");
    suggestAddition(contentDoc, annotationsDoc, {
      at: 7,
      text: "New\n\n",
      author: "alice",
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const widget = editor.view.dom.querySelector(".cm-annotation-addition");
    expect(widget?.textContent).toBe("New");
    expect(widget?.closest(".cm-line")).toBeNull();
    expect(widget?.closest(".cm-annotation-block")).not.toBeNull();
    const lines = Array.from(
      editor.view.dom.querySelectorAll(".cm-content > *"),
      (element) => element.textContent,
    );
    expect(lines).toEqual(["Para.", "", "New", "### Title"]);
  });

  test("on a blank line, too; in a line's middle, a text with a line break stays in it", () => {
    const blank = setUp("Para.\n\n### Title");
    suggestAddition(blank.contentDoc, blank.annotationsDoc, {
      at: 6,
      text: "\nNew\n",
      author: "alice",
    });
    attachAnnotationDecorations(
      blank.editor.view,
      new AnnotationIndex(blank.contentDoc, blank.annotationsDoc),
    );
    expect(
      blank.editor.view.dom
        .querySelector(".cm-annotation-addition")
        ?.closest(".cm-annotation-block"),
    ).not.toBeNull();

    const middle = setUp();
    suggestAddition(middle.contentDoc, middle.annotationsDoc, {
      at: 5,
      text: "\nthere",
      author: "alice",
    });
    attachAnnotationDecorations(
      middle.editor.view,
      new AnnotationIndex(middle.contentDoc, middle.annotationsDoc),
    );
    expect(
      middle.editor.view.dom
        .querySelector(".cm-annotation-addition")
        ?.closest(".cm-line"),
    ).not.toBeNull();
  });

  test("a suggestion whose change is invalid shows a warning instead of a text", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 5,
      end: 5,
      author: "mallory",
      change: new Uint8Array([1, 2, 3]),
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const widget = editor.view.dom.querySelector(".cm-annotation-invalid");
    expect(widget).not.toBeNull();
    expect(editor.view.dom.querySelector(".cm-line")?.textContent).toBe(
      "hello⚠ world",
    );
  });

  test("a substitution marks its old text; its replacement is not in the text (ADR-0018)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 0,
      end: 5,
      author: "alice",
      replacement: "bye",
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const dom = editor.view.dom;
    expect(dom.querySelector(".cm-annotation-substitution")?.textContent).toBe(
      "hello",
    );
    expect(editor.view.state.doc.toString()).toBe("hello world");
    expect(dom.querySelector(".cm-annotation-replacement")?.textContent).toBe(
      "bye",
    );
    expect(dom.querySelector(".cm-line")?.textContent).toBe("hellobye world");
  });

  test("for a screen reader, what a suggestion takes out is a deletion, what it proposes an insertion (11e.2)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 0,
      end: 5,
      author: "alice",
      replacement: "bye",
    });
    suggestAddition(contentDoc, annotationsDoc, {
      at: 11,
      text: "!",
      author: "alice",
    });
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );
    const dom = editor.view.dom;
    expect(dom.querySelector(".cm-annotation-substitution")?.tagName).toBe(
      "DEL",
    );
    expect(
      Array.from(dom.querySelectorAll("ins"), (ins) => ins.textContent),
    ).toEqual(["bye", "!"]);
  });

  test("a decided suggestion is no longer marked (a rejected deletion keeps its text, unstruck)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 5,
      author: "alice",
    });
    updateStatus(annotationsDoc, id, "rejected");

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    expect(editor.view.dom.querySelector(".cm-annotation-deletion")).toBeNull();
  });

  test("resolving a comment removes its marker from the editor", async () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "done?",
    });
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );
    expect(
      editor.view.dom.querySelector(".cm-annotation-comment"),
    ).not.toBeNull();

    updateStatus(annotationsDoc, id, "resolved");
    await notified();

    expect(editor.view.dom.querySelector(".cm-annotation-comment")).toBeNull();
  });

  // Found by the multi-peer simulation: a comment's widget sits at its range
  // *end*, so ordering decorations by range start fed CodeMirror unsorted
  // positions (it throws — inside a Loro subscriber, where the error is
  // swallowed and decorations silently stop updating).
  test("a comment whose range encloses another annotation renders both", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "outer",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 1,
      end: 3,
      author: "bob",
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    expect(
      editor.view.dom.querySelector(".cm-annotation-comment"),
    ).not.toBeNull();
    expect(
      editor.view.dom.querySelector(".cm-annotation-addition")?.textContent,
    ).toBe("el");
  });

  test("a comment highlights its passage, and says its text on hover (phase 10c)", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "needs work",
    });

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const mark = editor.view.dom.querySelector(".cm-annotation-comment");
    expect(mark?.textContent).toBe("hello");
    expect(mark?.getAttribute("title")).toBe("needs work");
    expect(editor.view.dom.querySelector(".cm-annotation-addition")).toBeNull();
  });

  test("a comment whose passage is gone keeps a marker where it was", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "needs work",
    });
    contentDoc.getText("content").delete(0, 5);
    contentDoc.commit();

    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const marker = editor.view.dom.querySelector(".cm-annotation-comment");
    expect(marker?.textContent).toBe("💬");
    expect(marker?.getAttribute("title")).toBe("needs work");
  });

  test("the active annotation stands out; a click on a mark makes it active", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "bob",
    });
    if (!created.ok) throw new Error("not created");
    const active = new ActiveAnnotation();
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
      active,
    );
    const mark = () =>
      editor.view.dom.querySelector<HTMLElement>(".cm-annotation-deletion");
    expect(mark()?.dataset.ann).toBe(created.id);
    expect(mark()?.classList.contains("cm-annotation-active")).toBe(false);

    active.set(created.id, "card");
    expect(mark()?.classList.contains("cm-annotation-active")).toBe(true);

    active.set(undefined, "card");
    press(mark(), 10);
    release(mark(), 10);
    expect(active.id).toBe(created.id);
  });

  // A section moved: the comment's passage gone, its marker left at the
  // end of where it was — a widget, whose events CodeMirror ignores
  // unless it says otherwise.
  test("a click on a comment's marker, its passage gone, makes it active", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "needs work",
    });
    if (!created.ok) throw new Error("not created");
    contentDoc.getText("content").delete(0, 5);
    contentDoc.commit();
    const active = new ActiveAnnotation();
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
      active,
    );
    const marker = editor.view.dom.querySelector(".cm-annotation-comment");
    expect(marker?.textContent).toBe("💬");

    press(marker, 10);
    release(marker, 10);
    expect(active.id).toBe(created.id);
  });

  test("a click on a suggestion's proposed text makes it active", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " there",
      author: "bob",
    });
    const index = new AnnotationIndex(contentDoc, annotationsDoc);
    const created = index.current().annotations[0];
    expect(created).toBeDefined();
    const active = new ActiveAnnotation();
    attachAnnotationDecorations(editor.view, index, active);
    const proposed = editor.view.dom.querySelector(
      "ins.cm-annotation-addition",
    );
    expect(proposed?.textContent).toBe(" there");

    press(proposed, 10);
    release(proposed, 10);
    expect(active.id).toBe(created?.id);
  });

  test("a click on a mark makes it active even when the press redraws the line under the pointer", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "bob",
    });
    if (!created.ok) throw new Error("not created");
    const active = new ActiveAnnotation();
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
      active,
    );
    const mark = editor.view.dom.querySelector<HTMLElement>(
      ".cm-annotation-deletion",
    );

    // The press reveals the line's markup: the text moves, the release
    // lands on the line, not on the mark (and the browser's click with it).
    press(mark, 10);
    release(editor.view.contentDOM, 10);
    editor.view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 10 }),
    );

    expect(active.id).toBe(created.id);
  });

  test("selecting by dragging from a mark doesn't make it active", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "bob",
    });
    if (!created.ok) throw new Error("not created");
    const active = new ActiveAnnotation();
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
      active,
    );
    const mark = editor.view.dom.querySelector<HTMLElement>(
      ".cm-annotation-deletion",
    );

    press(mark, 10);
    release(mark, 60);
    mark?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 60 }),
    );

    expect(active.id).toBeUndefined();
  });

  test("decorations recompute after a remote Loro import on content, reflecting the new resolved range", async () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 0,
      end: 5,
      author: "alice",
    });
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    // A remote peer inserts text inside the annotation, which grows it
    // (ADR-0014) — the decoration must grow to match, visibly in the
    // editor, not just in resolveRange.
    const remote = new LoroDoc();
    remote.setPeerId(2n);
    remote.import(contentDoc.export({ mode: "update" }));
    remote.getText("content").insert(2, "!!!");
    remote.commit();
    contentDoc.import(remote.export({ mode: "update" }));
    await notified();

    const marked = editor.view.dom.querySelector(".cm-annotation-addition");
    expect(marked?.textContent).toBe("he!!!llo");
  });

  test("a locally created annotation shows its decoration without waiting for an import", async () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 5,
      author: "alice",
    });
    await notified();

    expect(
      editor.view.dom.querySelector(".cm-annotation-deletion")?.textContent,
    ).toBe("hello");
  });

  test("a local keystroke unrelated to any annotation does not trigger a decoration recompute", () => {
    const { contentDoc, annotationsDoc, editor } = setUp();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 6,
      end: 11,
      author: "alice",
    });
    attachAnnotationDecorations(
      editor.view,
      new AnnotationIndex(contentDoc, annotationsDoc),
    );

    const dispatchSpy = vi.spyOn(editor.view, "dispatch");
    editor.view.dispatch({ changes: { from: 0, insert: "X" } }); // typing, not an import

    // Only the one dispatch the test itself issued for the keystroke — no
    // extra dispatch from a decoration recompute.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
