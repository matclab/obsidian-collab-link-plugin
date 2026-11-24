// @vitest-environment jsdom
// The selection toolbar (phase 10, decision 6): what can be done with a
// selection is always an annotation — comment, suggest, delete — offered
// next to it, never to a reader.
import { EditorSelection } from "@codemirror/state";
import { runScopeHandlers } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import type { Role } from "../../../lib/src/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import type { Mode } from "../reading/view-switch.js";
import {
  attachSelectionToolbar,
  toolbarPosition,
} from "./selection-toolbar.js";

afterEach(() => document.body.replaceChildren());

type Created = { type: string; extra: string; note: string; at?: number };

/** The page's mode, switched by the test. */
function modes(initial: Mode) {
  let mode = initial;
  const listeners: ((mode: Mode) => void)[] = [];
  return {
    mode: () => mode,
    onMode: (listener: (mode: Mode) => void) => {
      listeners.push(listener);
    },
    switchTo(next: Mode) {
      mode = next;
      for (const listener of listeners) listener(next);
      flushSync();
    },
  };
}

function setUp(
  role: Role,
  refuse?: string,
  text = "hello world",
  views?: ReturnType<typeof modes>,
) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createDocumentEditor(parent, doc, {
    readOnly: role !== "edit",
  });
  const created: Created[] = [];
  attachSelectionToolbar(editor.view, parent, {
    role,
    ...(views && { views }),
    create: (type, extra, note, at) => {
      created.push({ type, extra, note, ...(at !== undefined && { at }) });
      return refuse;
    },
  });
  const select = (from: number, to: number) => {
    editor.view.focus();
    editor.view.dispatch({
      selection: EditorSelection.single(from, to),
    });
    flushSync();
  };
  const toolbar = () =>
    parent.querySelector<HTMLElement>(".selection-toolbar:not([hidden])");
  const button = (label: string) =>
    Array.from(toolbar()?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent?.trim() === label,
    );
  const click = (label: string) => {
    button(label)?.click();
    flushSync();
  };
  const field = (selector: string) =>
    toolbar()?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  const fill = (selector: string, value: string) => {
    const element = field(selector);
    if (!element) throw new Error(`no ${selector}`);
    element.value = value;
    element.dispatchEvent(new Event("input"));
    flushSync();
  };
  const choose = (label: string) => {
    const radio = Array.from(
      toolbar()?.querySelectorAll<HTMLLabelElement>(".composer-place label") ??
        [],
    ).find((element) => element.textContent?.trim() === label);
    if (!radio) throw new Error(`no ${label}`);
    radio.click();
    flushSync();
  };
  const chosen = () =>
    toolbar()
      ?.querySelector<HTMLInputElement>(".composer-place input:checked")
      ?.closest("label")
      ?.textContent?.trim();
  return {
    editor,
    created,
    select,
    toolbar,
    button,
    click,
    field,
    fill,
    choose,
    chosen,
  };
}

describe("the selection toolbar", () => {
  test("nothing for a reader, nor without a selection for an editor", () => {
    const reader = setUp("read");
    reader.select(0, 5);
    expect(reader.toolbar()).toBeNull();

    const editor = setUp("edit");
    editor.select(3, 3);
    expect(editor.toolbar()).toBeNull();
    editor.select(0, 5);
    expect(editor.toolbar()).not.toBeNull();
    for (const label of ["Comment", "Suggest", "Delete"]) {
      expect(editor.button(label)).toBeDefined();
    }
  });

  test("Comment asks for the text, then creates a comment on the selection", () => {
    const { select, click, fill, created, toolbar } = setUp("suggest");
    select(6, 11);
    click("Comment");
    fill(".composer-text", "nice word");
    click("Comment");
    expect(created).toEqual([
      { type: "comment", extra: "nice word", note: "" },
    ]);
    expect(toolbar()?.querySelector(".composer")).toBeFalsy();
  });

  test("Suggest offers the selection to rewrite: changed, a substitution; emptied, a deletion", () => {
    const changed = setUp("suggest");
    changed.select(6, 11);
    changed.click("Suggest");
    expect(changed.field(".composer-text")?.value).toBe("world");
    changed.fill(".composer-text", "there");
    changed.fill(".composer-note", "warmer");
    changed.click("Suggest");
    expect(changed.created).toEqual([
      { type: "substitution", extra: "there", note: "warmer" },
    ]);

    const emptied = setUp("edit");
    emptied.select(0, 6);
    emptied.click("Suggest");
    emptied.fill(".composer-text", "");
    emptied.click("Suggest");
    expect(emptied.created).toEqual([
      { type: "deletion", extra: "", note: "" },
    ]);
  });

  test("a suggestion that changes nothing is refused, and says so", () => {
    const { select, click, created, toolbar } = setUp("suggest");
    select(6, 11);
    click("Suggest");
    click("Suggest");
    expect(created).toEqual([]);
    expect(toolbar()?.textContent).toContain("Nothing changes");
  });

  test("Delete shows the passage struck and asks why, then proposes its deletion", () => {
    const { select, click, fill, created, toolbar } = setUp("suggest");
    select(0, 5);
    click("Delete");
    expect(created).toEqual([]);
    expect(
      toolbar()?.querySelector(".composer-original del")?.textContent,
    ).toBe("hello");
    expect(toolbar()?.querySelector(".composer-text")).toBeNull();
    fill(".composer-note", "redundant");
    click("Delete");
    expect(created).toEqual([
      { type: "deletion", extra: "", note: "redundant" },
    ]);
  });

  test("Ctrl+Enter in the text is done; Enter alone a new line", () => {
    const { select, click, fill, created, field } = setUp("suggest");
    select(0, 5);
    click("Comment");
    fill(".composer-text", "first");
    field(".composer-text")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    flushSync();
    expect(created).toEqual([]);
    field(".composer-text")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    flushSync();
    expect(created).toEqual([{ type: "comment", extra: "first", note: "" }]);
  });

  test("Cmd+Enter too, on a Mac", () => {
    const { select, click, fill, created, field } = setUp("suggest");
    select(6, 11);
    click("Suggest");
    fill(".composer-text", "monde");
    field(".composer-text")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }),
    );
    flushSync();
    expect(created).toHaveLength(1);
  });

  test("Enter in the why is done", () => {
    const { select, click, fill, created, field } = setUp("suggest");
    select(0, 5);
    click("Delete");
    fill(".composer-note", "typo");
    field(".composer-note")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    flushSync();
    expect(created).toEqual([{ type: "deletion", extra: "", note: "typo" }]);
  });

  test("a deletion's why may stay empty", () => {
    const { select, click, created } = setUp("edit");
    select(6, 11);
    click("Delete");
    click("Delete");
    expect(created).toEqual([{ type: "deletion", extra: "", note: "" }]);
  });

  test("a reviewer with the cursor alone suggests an addition there", () => {
    const { select, click, fill, created, button } = setUp("suggest");
    select(5, 5);
    expect(button("Comment")).toBeUndefined();
    click("Suggest");
    fill(".composer-text", "!");
    click("Suggest");
    expect(created).toEqual([
      { type: "addition", extra: "!", note: "", at: 5 },
    ]);
  });

  test("an editor in Review suggests at the cursor alone, as a reviewer does (phase 24)", () => {
    const views = modes("review");
    const { select, click, fill, created, button, toolbar } = setUp(
      "edit",
      undefined,
      "hello world",
      views,
    );
    select(5, 5);
    expect(button("Comment")).toBeUndefined();
    expect(button("Suggest")).toBeDefined();

    // In Write, the caret alone is for typing.
    views.switchTo("write");
    expect(toolbar()).toBeNull();
    select(4, 4);
    expect(toolbar()).toBeNull();
    views.switchTo("review");
    expect(toolbar()).not.toBeNull();

    click("Suggest");
    fill(".composer-text", "!");
    click("Suggest");
    expect(created).toEqual([
      { type: "addition", extra: "!", note: "", at: 4 },
    ]);
  });

  test("at the start of a heading, a paragraph of its own before it, by default (phase 24)", () => {
    const { select, click, fill, created, chosen } = setUp(
      "suggest",
      undefined,
      "Para.\n\n### Title",
    );
    select(7, 7);
    click("Suggest");
    expect(chosen()).toBe("New paragraph before this line");
    fill(".composer-text", "New");
    click("Suggest");
    expect(created).toEqual([
      { type: "addition", extra: "New\n\n", note: "", at: 7 },
    ]);
  });

  test("or at the start of the heading's text, after its markup", () => {
    const { select, click, fill, created, choose } = setUp(
      "suggest",
      undefined,
      "Para.\n\n### Title",
    );
    select(7, 7);
    click("Suggest");
    choose("At the start of this line");
    fill(".composer-text", "New ");
    click("Suggest");
    expect(created).toEqual([
      { type: "addition", extra: "New ", note: "", at: 11 },
    ]);
  });

  test("on a blank line, a paragraph without asking; mid-line, the text as typed", () => {
    const blank = setUp("suggest", undefined, "Para.\n\n### Title");
    blank.select(6, 6);
    blank.click("Suggest");
    expect(blank.toolbar()?.querySelector(".composer-place")).toBeNull();
    blank.fill(".composer-text", "New");
    blank.click("Suggest");
    expect(blank.created).toEqual([
      { type: "addition", extra: "\nNew\n", note: "", at: 6 },
    ]);

    const mid = setUp("suggest");
    mid.select(5, 5);
    mid.click("Suggest");
    expect(mid.toolbar()?.querySelector(".composer-place")).toBeNull();
  });

  test("what the panel refuses is said, and the composer stays open", () => {
    const { select, click, fill, toolbar } = setUp("edit", "Conflicts");
    select(0, 5);
    click("Comment");
    fill(".composer-text", "hm");
    click("Comment");
    expect(toolbar()?.textContent).toContain("Conflicts");
    expect(toolbar()?.querySelector(".composer")).toBeTruthy();
  });

  test("pressing a button leaves the focus in the editor, the composer's fields take it", () => {
    // Blurred, the editor hides the line's markup again (`## … ##`, `*`):
    // the line shrinks, the toolbar moves from under the pointer, and the
    // click is lost.
    const { select, button, click, field } = setUp("edit");
    select(0, 5);
    for (const label of ["Comment", "Suggest", "Delete"]) {
      const press = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      button(label)?.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
    click("Comment");
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    field(".composer-text")?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });

  test("Ctrl+Alt+M comments the selection", () => {
    const { editor, select, toolbar } = setUp("edit");
    select(0, 5);
    const handled = runScopeHandlers(
      editor.view,
      new KeyboardEvent("keydown", { key: "m", ctrlKey: true, altKey: true }),
      "editor",
    );
    flushSync();
    expect(handled).toBe(true);
    expect(toolbar()?.querySelector(".composer-text")).toBeTruthy();
  });
});

// Found at the real trial of phase 34 (2026-11-19): on Android, the
// system's menu (copy, paste…) opens above a selection made with a
// finger, over the toolbar.
describe("where the toolbar goes", () => {
  // A selection on one line, 200 px down a 400 px wide parent.
  const selection = {
    start: { top: 200, bottom: 220, left: 100 },
    end: { top: 200, bottom: 220, right: 180 },
    box: { top: 0, left: 0, width: 400 },
    width: 120,
    height: 30,
  };

  test("with a mouse, above the selection, centred on it", () => {
    expect(toolbarPosition({ ...selection, touch: false })).toEqual({
      top: 200 - 30 - 8,
      left: 140 - 60,
    });
  });

  test("with a mouse, below when there is no room above", () => {
    const high = {
      ...selection,
      start: { ...selection.start, top: 10 },
      end: { ...selection.end, top: 10, bottom: 30 },
    };
    expect(toolbarPosition({ ...high, touch: false }).top).toBe(30 + 8);
  });

  test("with a finger, below, past the selection's handles, room above or not", () => {
    const { top } = toolbarPosition({ ...selection, touch: true });
    expect(top).toBeGreaterThanOrEqual(220 + 24);
  });

  test("kept within the parent's width", () => {
    const right = {
      ...selection,
      start: { ...selection.start, left: 380 },
      end: { ...selection.end, right: 400 },
    };
    expect(toolbarPosition({ ...right, touch: true }).left).toBe(400 - 120);
  });
});
