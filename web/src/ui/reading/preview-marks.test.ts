// @vitest-environment jsdom
// The annotations in the preview (phase 10, decision 7): on their very
// text when it is found in its block, else on the block.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  AnnotationIndex,
  tryCreateAnnotation,
} from "../../../lib/src/annotations/index.js";
import { attachAnnotationDecorations } from "../../editor/annotation-decorations.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { counter, resetCounters } from "../../perf/index.js";
import { renderMarkdownBlocks } from "../../render/index.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import {
  type PreviewMark,
  attachPreviewMarks,
  markPreview,
  shownAnchor,
} from "./preview-marks.js";
import { createPreview } from "./preview.js";

function preview(source: string) {
  const root = document.createElement("div");
  const { html, lines } = renderMarkdownBlocks(source);
  root.innerHTML = html;
  Array.from(root.children).forEach((child, i) => {
    const [start, end] = lines[i] ?? [0, 0];
    (child as HTMLElement).dataset.line = String(start);
    (child as HTMLElement).dataset.lineEnd = String(end);
  });
  return root;
}

/** Line `n` of `source`, as `markPreview` reads it. */
const lineOf = (source: string) => (n: number) => source.split("\n")[n] ?? "";

const mark = (over: Partial<PreviewMark>): PreviewMark => ({
  id: "a",
  type: "comment",
  line: 0,
  column: 0,
  excerpt: "",
  active: false,
  ...over,
});

describe("markPreview", () => {
  test("a comment's passage, found in its block, is marked there", () => {
    const source = "# Title\n\nhello world";
    const root = preview(source);
    markPreview(
      root,
      [mark({ line: 2, column: 6, excerpt: "world" })],
      lineOf(source),
    );
    const marked = root.querySelector<HTMLElement>('[data-ann="a"]');
    expect(marked?.textContent).toBe("world");
    expect(marked?.classList.contains("cm-annotation-comment")).toBe(true);
    expect(root.querySelector("p")?.textContent).toBe("hello world");
  });

  test("a substitution strikes its passage and shows what it proposes after it; an addition shows its text", () => {
    const source = "one two three";
    const root = preview(source);
    markPreview(
      root,
      [
        mark({
          id: "s",
          type: "substitution",
          column: 4,
          excerpt: "two",
          proposal: "2",
        }),
        mark({
          id: "d",
          type: "addition",
          column: 8,
          excerpt: "three",
          proposal: "!",
        }),
      ],
      lineOf(source),
    );
    const struck = root.querySelector<HTMLElement>(
      ".cm-annotation-substitution",
    );
    expect(struck?.textContent).toBe("two");
    expect(struck?.nextElementSibling?.textContent).toBe("2");
    expect(root.querySelector(".cm-annotation-addition")?.textContent).toBe(
      "!",
    );
    expect(root.querySelector("p")?.textContent).toBe("one two2 three!");
    // For a screen reader: a deletion, then insertions (11e.2).
    expect(struck?.tagName).toBe("DEL");
    expect(struck?.nextElementSibling?.tagName).toBe("INS");
  });

  test("a passage the rendering changed marks its block instead", () => {
    const source = "some *emphasised* text";
    const root = preview(source);
    markPreview(
      root,
      [mark({ column: 5, excerpt: "*emphasised* text" })],
      lineOf(source),
    );
    expect(root.querySelector('[data-ann="a"]')).toBeNull();
    expect(root.querySelector("p")?.dataset.annBlock).toContain("a");
  });

  test("marking again first takes the previous marks away", () => {
    const source = "hello world";
    const root = preview(source);
    const world = { column: 6, excerpt: "world" };
    markPreview(root, [mark({ ...world, active: true })], lineOf(source));
    markPreview(root, [mark(world)], lineOf(source));
    expect(root.querySelectorAll('[data-ann="a"]')).toHaveLength(1);
    expect(root.querySelector(".cm-annotation-active")).toBeNull();
    markPreview(root, [], lineOf(source));
    expect(root.querySelector("[data-ann]")).toBeNull();
    expect(root.innerHTML).toBe(preview("hello world").innerHTML);
  });

  test("never inside a formula or a diagram", () => {
    const source = "$x$ and x";
    const root = preview(source);
    markPreview(root, [mark({ column: 1, excerpt: "x" })], lineOf(source));
    expect(root.querySelector(".math [data-ann]")).toBeNull();
  });

  test("a callout's default title is not in its source: not counted", () => {
    const source = "> [!note]\n> Note this";
    const root = preview(source);
    markPreview(
      root,
      [mark({ line: 1, column: 2, excerpt: "Note" })],
      lineOf(source),
    );
    expect(
      root.querySelector('.md-callout-content [data-ann="a"]')?.textContent,
    ).toBe("Note");
  });

  test("the annotation to reveal opens the folded callouts holding it, and only those", () => {
    const source =
      "> [!note]- A\n> > [!tip]- B\n> > word\n\n> [!info]- C\n> other";
    const root = preview(source);
    const details = () =>
      Array.from(root.querySelectorAll("details"), (element) => element.open);
    const word = mark({ line: 2, column: 4, excerpt: "word" });
    markPreview(root, [word], lineOf(source));
    expect(details()).toEqual([false, false, false]);
    markPreview(root, [word], lineOf(source), "a");
    expect(details()).toEqual([true, true, false]);
  });

  test("revealed on its block: the callout opens when the passage is in its content", () => {
    const source = "> [!note]- A *b*\n> some *emphasised* text";
    const root = preview(source);
    const inTitle = mark({ id: "t", column: 13, excerpt: "*b*" });
    markPreview(root, [inTitle], lineOf(source), "t");
    expect(root.querySelector("details")?.open).toBe(false);
    const inContent = mark({
      line: 1,
      column: 7,
      excerpt: "*emphasised* text",
    });
    markPreview(root, [inContent], lineOf(source), "a");
    expect(root.querySelector("details")?.dataset.annBlock).toBe("a");
    expect(root.querySelector("details")?.open).toBe(true);
  });

  test("a passage the rendering hides (a link's address) marks its block, not the same text shown elsewhere", () => {
    const source =
      'Un [lien](https://example.org "titre"), un lien automatique <https://example.org>.';
    const root = preview(source);
    markPreview(
      root,
      [
        mark({
          type: "substitution",
          column: 26,
          excerpt: "org",
          proposal: "com",
        }),
      ],
      lineOf(source),
    );
    expect(root.querySelector("[data-ann]")).toBeNull();
    expect(root.querySelector("p")?.dataset.annBlock).toBe("a");
    // Its bar takes the colour of the first annotation's type.
    expect(root.querySelector("p")?.dataset.annType).toBe("substitution");
    markPreview(root, [], lineOf(source));
    expect(root.querySelector("p")?.dataset.annType).toBeUndefined();
  });

  test("a passage whose text comes more than once is marked where it is, not on its first occurrence", () => {
    const source = "the cat and the dog";
    const root = preview(source);
    markPreview(root, [mark({ column: 12, excerpt: "the" })], lineOf(source));
    const marked = root.querySelector<HTMLElement>('[data-ann="a"]');
    expect(marked?.previousSibling?.textContent).toBe("the cat and ");
    expect(marked?.nextSibling?.textContent).toBe(" dog");
  });

  test("two passages of the same text, one with a proposal of it: each on its own", () => {
    const source = "a cat and the dog\nand the bird";
    const root = preview(source);
    markPreview(
      root,
      [
        mark({
          id: "s",
          type: "substitution",
          column: 0,
          excerpt: "a",
          proposal: "the",
        }),
        mark({ id: "c", line: 1, column: 4, excerpt: "the" }),
        mark({ id: "d", column: 10, excerpt: "the" }),
      ],
      lineOf(source),
    );
    expect(root.querySelector("p")?.dataset.annBlock).toBeUndefined();
    const text = (id: string) =>
      root.querySelector<HTMLElement>(`[data-ann="${id}"]:not(ins)`)
        ?.textContent;
    expect([text("s"), text("c"), text("d")]).toEqual(["a", "the", "the"]);
    expect(root.querySelector('[data-ann="c"]')?.nextSibling?.textContent).toBe(
      " bird",
    );
    expect(root.querySelector('[data-ann="d"]')?.nextSibling?.textContent).toBe(
      " dog\nand ",
    );
  });
});

describe("shownAnchor", () => {
  test("a mark in folded callouts stands at the outermost one's title; shown, at itself", () => {
    const source = "> [!note]- A\n> > [!tip]- B\n> > word\n\nplain";
    const root = preview(source);
    markPreview(
      root,
      [
        mark({ line: 2, column: 4, excerpt: "word" }),
        mark({ id: "p", line: 4, excerpt: "plain" }),
      ],
      lineOf(source),
    );
    const word = root.querySelector<HTMLElement>('[data-ann="a"]');
    const plain = root.querySelector<HTMLElement>('[data-ann="p"]');
    const [outer, inner] = Array.from(root.querySelectorAll("details"));
    if (!word || !plain || !outer || !inner) throw new Error("not marked");
    expect(shownAnchor(word)).toBe(outer.querySelector(":scope > summary"));
    outer.open = true;
    expect(shownAnchor(word)).toBe(inner.querySelector(":scope > summary"));
    inner.open = true;
    expect(shownAnchor(word)).toBe(word);
    expect(shownAnchor(plain)).toBe(plain);
    expect(shownAnchor(outer)).toBe(outer);
  });
});

describe("attachPreviewMarks", () => {
  test("marks after each rendering of the shown preview, never while hidden; a click on a mark makes it active", async () => {
    vi.useFakeTimers();
    try {
      const contentDoc = new LoroDoc();
      contentDoc.getText("content").insert(0, "# T\n\nhello world");
      contentDoc.commit();
      const annotationsDoc = new LoroDoc();
      const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
        type: "comment",
        start: 11,
        end: 16,
        author: "bob",
        body: "hm",
      });
      if (!created.ok) throw new Error("not created");
      const parent = document.createElement("div");
      document.body.append(parent);
      const editor = createDocumentEditor(parent, contentDoc);
      const index = new AnnotationIndex(contentDoc, annotationsDoc);
      const active = new ActiveAnnotation();
      attachAnnotationDecorations(editor.view, index, active);
      const shown = createPreview(parent, editor.view);
      resetCounters();
      attachPreviewMarks(shown, editor.view, index, active);
      expect(counter("preview.marks")).toBe(0); // hidden

      shown.show();
      expect(counter("preview.marks")).toBe(1);
      const marked = shown.root.querySelector<HTMLElement>("[data-ann]");
      expect(marked?.textContent).toBe("world");

      editor.view.dispatch({ changes: { from: 5, insert: "say " } });
      expect(counter("preview.marks")).toBe(1); // not before it renders
      vi.runAllTimers();
      expect(counter("preview.marks")).toBe(2);
      expect(shown.root.querySelector("[data-ann]")?.textContent).toBe("world");

      shown.root.querySelector<HTMLElement>("[data-ann]")?.click();
      expect(active.id).toBe(created.id);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an annotation made active opens its folded callout, once: closed again, it stays closed", async () => {
    vi.useFakeTimers();
    try {
      const contentDoc = new LoroDoc();
      contentDoc
        .getText("content")
        .insert(0, "> [!note]- A\n> hello world\n\nend");
      contentDoc.commit();
      const annotationsDoc = new LoroDoc();
      const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
        type: "comment",
        start: 21,
        end: 26,
        author: "bob",
        body: "hm",
      });
      if (!created.ok) throw new Error("not created");
      const parent = document.createElement("div");
      document.body.append(parent);
      const editor = createDocumentEditor(parent, contentDoc);
      const index = new AnnotationIndex(contentDoc, annotationsDoc);
      const active = new ActiveAnnotation();
      attachAnnotationDecorations(editor.view, index, active);
      const shown = createPreview(parent, editor.view);
      attachPreviewMarks(shown, editor.view, index, active);
      const folded = () => shown.root.querySelector("details");

      // Chosen while the preview is hidden: opened when it shows.
      active.set(created.id, "card");
      shown.show();
      expect(folded()?.querySelector("[data-ann]")?.textContent).toBe("world");
      expect(folded()?.open).toBe(true);

      folded()?.removeAttribute("open");
      editor.view.dispatch({ changes: { from: 29, insert: "the " } });
      vi.runAllTimers();
      expect(folded()?.open).toBe(false);

      active.set(undefined, "card");
      active.set(created.id, "card");
      expect(folded()?.open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
