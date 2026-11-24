// @vitest-environment jsdom
// The menu of a link to a heading on screen (phase 20, decision 9): the
// page's editor, its headings from the outline as the view gives them; a
// list under the caret, each heading set in by its level, said to a
// screen reader from the text, chosen by a click; no cost to a keystroke
// that doesn't open it.
import { EditorSelection, StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { followEditor } from "../outline/follow-editor.js";
import { OutlineIndex } from "../outline/outline-index.js";
import { counter, resetCounters } from "../perf/index.js";
import { anchorHeadings, anchorState } from "./anchor-menu.js";
import { createDocumentEditor } from "./editor.js";
import { withoutLayout } from "./test-support/no-layout.js";

const destroyed = withoutLayout();

function setUp(text: string) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createDocumentEditor(parent, doc);
  destroyed(editor.view);
  const view = editor.view;
  // As the view wires it (`document-view.ts`).
  const outline = new OutlineIndex(view.state.doc);
  followEditor(view, outline);
  const headings = vi.fn(() => outline.current());
  view.dispatch({
    effects: StateEffect.appendConfig.of(anchorHeadings.of(headings)),
  });
  view.dispatch({ selection: EditorSelection.cursor(text.length) });
  view.focus();
  const type = (chars: string) => {
    for (const char of chars) {
      const at = view.state.selection.main.head;
      view.dispatch({
        changes: { from: at, insert: char },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      });
    }
  };
  const list = () => parent.querySelector<HTMLElement>('[role="listbox"]');
  const options = () =>
    Array.from(list()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  return { view, type, list, options, headings };
}

const PLAN = "# Mon titre\n\n## Relevé 19.0\n\ntexte ";

describe("the menu of a link to a heading on screen", () => {
  test("the headings, set in by their level, the active one said from the text", () => {
    const { view, type, list, options } = setUp(PLAN);
    type("[t](#");
    expect(list()?.getAttribute("aria-label")).toBe("Headings of the document");
    expect(options().map((option) => option.textContent)).toEqual([
      "Mon titre",
      "Relevé 19.0",
    ]);
    expect(options().map((option) => option.dataset.level)).toEqual(["1", "2"]);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.contentDOM.getAttribute("aria-controls")).toBe(list()?.id);
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(
      options()[0]?.id,
    );
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown" }),
    );
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter" }),
    );
    expect(view.state.doc.toString()).toBe(`${PLAN}[t](#Relevé%2019.0)`);
    expect(list()).toBeNull();
    expect(view.contentDOM.hasAttribute("aria-controls")).toBe(false);
  });

  test("a click on an option chooses it, the focus kept in the text", () => {
    const { view, type, options } = setUp(PLAN);
    type("[[#");
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    options()[0]?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(`${PLAN}[[#Mon titre]]`);
  });

  test("a heading written meanwhile is offered", () => {
    const { view, type, options } = setUp(PLAN);
    view.dispatch({ changes: { from: 0, insert: "# Neuf\n\n" } });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    type("[t](#");
    expect(options().map((option) => option.textContent)).toEqual([
      "Neuf",
      "Mon titre",
      "Relevé 19.0",
    ]);
  });

  test("Escape closes it, the text as typed", () => {
    const { view, type, list } = setUp(PLAN);
    type("[t](#mon");
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect(list()).toBeNull();
    expect(anchorState(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe(`${PLAN}[t](#mon`);
  });

  test("a second editor adds no style rule of the menus' lists", () => {
    // Found by the slowness of a scenario of many editors: the lists'
    // theme made again for each editor added its rules each time.
    const sheets = () =>
      Array.from(document.styleSheets).reduce(
        (rules, sheet) => rules + sheet.cssRules.length,
        0,
      );
    setUp(PLAN);
    const before = sheets();
    setUp(PLAN);
    expect(sheets()).toBe(before);
  });

  test("a keystroke that doesn't open it reads no heading", () => {
    const { type, headings } = setUp(PLAN);
    resetCounters();
    headings.mockClear();
    type("abc # (#) [x]( [ #");
    expect(counter("anchor.open")).toBe(0);
    expect(headings).not.toHaveBeenCalled();
    type("[t](#");
    expect(counter("anchor.open")).toBe(1);
    expect(headings).toHaveBeenCalledTimes(1);
  });
});
