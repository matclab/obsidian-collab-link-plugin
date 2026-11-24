// @vitest-environment jsdom
// Going where `[t](#x)` leads (docs/phase-19-liens.md, decision 8): the
// heading `headingForFragment` finds, as the outline goes to it — the
// editor's caret, or the preview's block when the editor is hidden.
import { LoroDoc } from "loro-crdt";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDocumentEditor } from "../../editor/editor.js";
import { followEditor } from "../../outline/follow-editor.js";
import { OutlineIndex } from "../../outline/outline-index.js";
import { goToAnchor } from "./outline-navigation.js";

const TEXT = "# Un\n\npara\n\n## Mon titre\n\ntexte\n\n## Mon titre\n\nfin";

// What jsdom lacks: the boxes CodeMirror measures once asked to scroll.
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

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setUp() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, TEXT);
  contentDoc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const previewRoot = document.createElement("div");
  // The preview's top-level blocks carry their source lines.
  previewRoot.innerHTML = [0, 2, 4, 6, 8, 10]
    .map((line) => `<p data-line="${line}">${line}</p>`)
    .join("");
  parent.append(previewRoot);
  const editor = createDocumentEditor(parent, contentDoc, {});
  const index = new OutlineIndex(editor.view.state.doc);
  followEditor(editor.view, index);
  cleanups.push(() => {
    editor.destroy();
    parent.remove();
  });
  const surfaces = {
    view: editor.view,
    previewRoot,
    ownColumn: () => false,
    readingTop: () => 0,
  };
  return { view: editor.view, previewRoot, index, surfaces };
}

describe("goToAnchor", () => {
  test("the editor shown: its caret on the heading the fragment leads to", () => {
    const { view, index, surfaces } = setUp();
    expect(goToAnchor(index, surfaces, "mon-titre-1")).toBe(true);
    expect(view.state.selection.main.head).toBe(TEXT.lastIndexOf("## Mon"));
    expect(goToAnchor(index, surfaces, "MON TITRE")).toBe(true);
    expect(view.state.selection.main.head).toBe(TEXT.indexOf("## Mon"));
  });

  test("the editor hidden: the preview's block of the heading brought into view", () => {
    const { view, previewRoot, index, surfaces } = setUp();
    view.dom.hidden = true;
    const scrolled: string[] = [];
    for (const block of Array.from(previewRoot.children)) {
      (block as HTMLElement).scrollIntoView = () =>
        scrolled.push(block.getAttribute("data-line") ?? "");
    }
    expect(goToAnchor(index, surfaces, "Mon titre")).toBe(true);
    expect(scrolled).toEqual(["4"]);
  });

  test("a fragment that leads nowhere: false, nothing moved", () => {
    const { view, index, surfaces } = setUp();
    const before = view.state.selection;
    expect(goToAnchor(index, surfaces, "Autre")).toBe(false);
    expect(view.state.selection.eq(before)).toBe(true);
  });
});
