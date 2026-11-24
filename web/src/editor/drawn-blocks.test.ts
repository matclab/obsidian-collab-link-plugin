// @vitest-environment jsdom
// The blocks a host's editor draws in place of their text (Obsidian's
// callouts, tables and formula blocks; choice/obsidian/blocks): one that
// holds an open annotation is framed, as the annotation's text there is
// out of sight; chosen on a card, the caret goes into it, and Obsidian
// shows its source.
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  type AnnotationType,
  tryCreateAnnotation,
} from "../../lib/src/annotations/index.js";
import { counter } from "../perf/index.js";
import { ActiveAnnotation } from "../view-model/active-annotation.js";
import { attachAnnotationDecorations } from "./annotation-decorations.js";
import { blocksHolding, revealInDrawnBlock } from "./drawn-blocks.js";
import { type EditorFactory, createDocumentEditor } from "./editor.js";
import { obsidianDrawing, obsidianLike } from "./test-support/obsidian-like.js";

describe("blocksHolding", () => {
  const block = { from: 10, to: 20 };
  const held = (from: number, to: number, kind = "annotation" as const) =>
    blocksHolding([block], [{ from, to, kind }]);

  test("a point from the block's start to its end is held", () => {
    expect(held(10, 10)).toEqual([{ ...block, active: false }]);
    expect(held(15, 15)).toEqual([{ ...block, active: false }]);
    expect(held(20, 20)).toEqual([{ ...block, active: false }]);
    expect(held(9, 9)).toEqual([]);
    expect(held(21, 21)).toEqual([]);
  });

  test("a range is held when any of it is in the block", () => {
    expect(held(5, 11)).toEqual([{ ...block, active: false }]);
    expect(held(19, 30)).toEqual([{ ...block, active: false }]);
    expect(held(5, 10)).toEqual([]);
    expect(held(20, 30)).toEqual([]);
  });

  test("the active annotation's makes it active; a remote caret, nothing", () => {
    expect(held(12, 14, "active" as never)).toEqual([
      { ...block, active: true },
    ]);
    expect(held(12, 14, "cursor" as never)).toEqual([]);
    expect(
      blocksHolding(
        [block],
        [
          { from: 11, to: 12, kind: "annotation" },
          { from: 13, to: 14, kind: "active" },
        ],
      ),
    ).toEqual([{ ...block, active: true }]);
  });
});

const TEXT = "Avant.\n\n> [!note] Titre\n> Le contenu.\n\nAprès.";
const CALLOUT = { from: TEXT.indexOf(">"), to: TEXT.indexOf(".\n\nAprès") + 1 };

const drawing = obsidianDrawing(CALLOUT.from, CALLOUT.to);

const parents: Element[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) parent.remove();
});

function setUp(provide: EditorFactory = drawing) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, TEXT);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const parent = document.createElement("div");
  document.body.append(parent);
  parents.push(parent);
  const editor = createDocumentEditor(parent, contentDoc, { provide });
  const index = new AnnotationIndex(contentDoc, annotationsDoc);
  const active = new ActiveAnnotation();
  attachAnnotationDecorations(editor.view, index, active);
  const annotate = async (type: AnnotationType, needle: string) => {
    const start = TEXT.indexOf(needle);
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type,
      start,
      end: start + needle.length,
      author: "bob",
    });
    if (!created.ok) throw new Error("not created");
    await Promise.resolve();
    return created.id;
  };
  /** The frames, once CodeMirror has measured. */
  const frames = async () => {
    await new Promise((done) => requestAnimationFrame(done));
    await new Promise((done) => requestAnimationFrame(done));
    return Array.from(editor.view.dom.querySelectorAll(".cm-drawn-block")).map(
      (frame) => frame.classList.contains("cm-drawn-block-active"),
    );
  };
  return { view: editor.view, active, annotate, frames };
}

describe("in an editor a host provides", () => {
  test("a drawn block holding an open annotation is framed", async () => {
    const { annotate, frames } = await setUp();
    expect(await frames()).toEqual([]);

    await annotate("deletion", "contenu");

    expect(await frames()).toEqual([false]);
  });

  test("an annotation outside the drawn blocks frames nothing", async () => {
    const { annotate, frames } = await setUp();
    await annotate("deletion", "Après");

    expect(await frames()).toEqual([]);
  });

  test("the active annotation's block is framed as such", async () => {
    const { annotate, frames, active } = await setUp();
    const id = await annotate("comment", "contenu");
    active.set(id, "card");

    expect(await frames()).toEqual([true]);
  });

  test("an editor that draws no block frames nothing", async () => {
    const { annotate, frames } = await setUp(obsidianLike);
    await annotate("deletion", "contenu");

    expect(await frames()).toEqual([]);
  });

  test("a keystroke, no block drawn, reads no annotation", async () => {
    const { view, annotate, frames } = await setUp(obsidianLike);
    await annotate("deletion", "contenu");
    await frames();

    const before = counter("live.reveal");
    view.dispatch({
      changes: { from: 0, insert: "k" },
      userEvent: "input.type",
    });
    await frames();

    expect(counter("live.reveal") - before).toBe(0);
  });
});

describe("revealInDrawnBlock", () => {
  test("a passage in a drawn block: the caret goes there, the editor focused", () => {
    const { view } = setUp();
    const at = TEXT.indexOf("contenu");

    expect(revealInDrawnBlock(view, at)).toBe(true);
    expect(view.state.selection.main.head).toBe(at);
    expect(view.hasFocus).toBe(true);
  });

  test("a passage in the text: nothing moves", () => {
    const { view } = setUp();

    expect(revealInDrawnBlock(view, TEXT.indexOf("Après"))).toBe(false);
    expect(view.state.selection.main.head).toBe(0);
    expect(view.hasFocus).toBe(false);
  });
});
