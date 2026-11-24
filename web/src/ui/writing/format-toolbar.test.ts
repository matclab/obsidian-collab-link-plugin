// @vitest-environment jsdom
// The formatting toolbar (phase 20b): over the text, an editor's only,
// hideable, its state the selection's.
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AnnotationIndex } from "../../../lib/src/annotations/index.js";
import type { Role } from "../../../lib/src/crypto/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { withoutLayout } from "../../editor/test-support/no-layout.js";
import { counter, resetCounters } from "../../perf/index.js";
import { createViewSwitch } from "../reading/view-switch.js";
import { createFormatToolbar } from "./format-toolbar.js";

const destroyed = withoutLayout();

function setUp(
  role: Role = "edit",
  text = "a b c",
  narrowAtFirst = false,
  onHelp?: () => void,
) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createDocumentEditor(parent, contentDoc, {
    readOnly: role !== "edit",
  });
  destroyed(editor.view);
  const index = new AnnotationIndex(contentDoc, new LoroDoc());
  const views = createViewSwitch(parent, editor, index, role, {
    author: () => "me",
    confirm: () => true,
    preferences: localStorage,
  });
  let narrow = narrowAtFirst;
  const widthListeners: (() => void)[] = [];
  const toolbar = createFormatToolbar(views, editor, {
    role,
    preferences: localStorage,
    mac: false,
    ...(onHelp && { onHelp }),
    narrow: {
      matches: () => narrow,
      onChange: (listener) => widthListeners.push(listener),
    },
  });
  const select = (from: number, to = from) =>
    editor.view.dispatch({ selection: EditorSelection.single(from, to) });
  const button = (name: string) =>
    parent.querySelector<HTMLButtonElement>(
      `.format-toolbar button[aria-label="${name}"]`,
    );
  const narrowNow = (next: boolean) => {
    narrow = next;
    for (const listener of widthListeners) listener();
  };
  return { parent, editor, views, toolbar, select, button, narrowNow };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.textContent = "";
});

describe("the formatting toolbar", () => {
  // ADR-0064, AC10: named beside its icon, its name in its accessible one;
  // the name hidden on a narrow view (page.css).
  test("its help button says « Help »", () => {
    const { button } = setUp("edit", "a b c", false, () => {});
    const help = button("Writing help");
    expect(help?.querySelector(".toolbar-help-label")?.textContent).toBe(
      "Help",
    );
    expect(help?.getAttribute("aria-label")?.toLowerCase()).toContain("help");
  });

  test("an editor's, first in the bar over the text; Bold bolds the selection", () => {
    const { views, editor, select, button } = setUp();
    expect(views.bar.firstElementChild?.classList).toContain("format-toolbar");
    select(2, 3);
    button("Bold")?.click();
    expect(editor.view.state.doc.toString()).toBe("a **b** c");
  });

  test("a button is pressed where its construct is at the selection", () => {
    const { select, button } = setUp("edit", "a **b** c\n- d");
    select(4);
    expect(button("Bold")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Bulleted list")?.getAttribute("aria-pressed")).toBe("false");
    select(12);
    expect(button("Bold")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("Bulleted list")?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a click leaves the focus, and the selection, in the text", () => {
    const { editor, select, button } = setUp();
    editor.view.focus();
    select(2, 3);
    const bold = button("Bold");
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    bold?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    bold?.click();
    expect(editor.view.hasFocus).toBe(true);
  });

  test("from the keyboard, back to the text once done", () => {
    const { editor, select, button } = setUp();
    select(2, 3);
    button("Bold")?.focus();
    button("Bold")?.click();
    expect(editor.view.state.doc.toString()).toBe("a **b** c");
    expect(editor.view.hasFocus).toBe(true);
  });

  test("one tab stop; the arrows, Home and End between the controls", () => {
    const { parent } = setUp();
    const controls = Array.from(
      parent.querySelectorAll<HTMLElement>(".format-controls .format-control"),
    );
    expect(controls.filter((control) => control.tabIndex === 0)).toHaveLength(
      1,
    );
    const [first, second] = controls;
    first?.focus();
    first?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(second);
    second?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(document.activeElement).toBe(controls.at(-1));
    expect(controls.filter((control) => control.tabIndex === 0)).toEqual([
      controls.at(-1),
    ]);
    controls
      .at(-1)
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    expect(document.activeElement).toBe(first);
  });

  test("the shortcut in the button's title, as the platform writes it", () => {
    const { button } = setUp();
    expect(button("Bold")?.title).toBe("Bold (Ctrl+B)");
  });

  test("never a reviewer's, a reader's, nor in a host's editor", () => {
    expect(setUp("suggest").toolbar).toBeUndefined();
    expect(setUp("read").toolbar).toBeUndefined();
  });

  test("only in Write, over the editor: not in History, nor over the preview", () => {
    const { parent, views } = setUp();
    const toolbar = parent.querySelector<HTMLElement>(".format-toolbar");
    const modeButton = (name: string) =>
      Array.from(parent.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === name,
      );
    modeButton("History")?.click();
    expect(views.mode()).toBe("history");
    expect(toolbar?.hidden).toBe(true);
    modeButton("Write")?.click();
    expect(toolbar?.hidden).toBe(false);
    modeButton("Reading")?.click();
    expect(toolbar?.hidden).toBe(true);
  });

  test("the paragraph menu names the form at the selection, and applies another", () => {
    const { parent, editor, select } = setUp("edit", "## a\nb\n#### c");
    const style = parent.querySelector<HTMLSelectElement>(
      '.format-toolbar select[aria-label="Paragraph style"]',
    );
    select(2);
    expect(style?.value).toBe("heading2");
    select(5);
    expect(style?.value).toBe("paragraph");
    // Not offered in the menu, but named when it is the form.
    select(10);
    expect(style?.value).toBe("heading4");
    select(0, 6);
    expect(style?.selectedOptions[0]?.textContent).toBe("Mixed");
    expect(style?.disabled).toBe(false);
    select(5);
    if (style) style.value = "heading1";
    style?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.view.state.doc.toString()).toBe("## a\n# b\n#### c");
    expect(editor.view.hasFocus).toBe(true);
  });

  test("the paragraph menu disabled where no line has a form", () => {
    const { parent, select } = setUp("edit", "```\ncode\n```\ntext");
    const style = parent.querySelector<HTMLSelectElement>(".paragraph-style");
    select(5);
    expect(style?.disabled).toBe(true);
    select(15);
    expect(style?.disabled).toBe(false);
  });

  test("the insert menu: opened, gone through by the arrows, a block put", () => {
    const { parent, editor, select, button } = setUp("edit", "a");
    select(1);
    const insert = button("Insert");
    expect(insert?.getAttribute("aria-haspopup")).toBe("menu");
    expect(insert?.getAttribute("aria-expanded")).toBe("false");
    insert?.click();
    expect(insert?.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(
      parent.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
    );
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Table",
      "Callout",
      "Code block",
      "Formula",
      "Diagram",
      "Horizontal line",
      "Footnote",
    ]);
    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(document.activeElement).toBe(items[1]);
    items[1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    items[0]?.click();
    expect(editor.view.state.doc.toString()).toBe(
      "a\n\n|  |  |\n| --- | --- |\n|  |  |",
    );
    expect(parent.querySelector('[role="menu"]')).toBeNull();
    expect(editor.view.hasFocus).toBe(true);
  });

  test("the insert menu closed by Escape, the focus back on its button", () => {
    const { parent, button } = setUp();
    button("Insert")?.click();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(parent.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button("Insert"));
  });

  test("hidden by its button, shown again by another; kept by this browser", () => {
    const first = setUp();
    first.button("Hide the formatting toolbar")?.click();
    expect(first.parent.querySelector(".format-controls")).toBeNull();
    expect(localStorage.getItem("obsidian-collab:toolbar")).toBe("hidden");
    const again = setUp();
    expect(again.parent.querySelector(".format-controls")).toBeNull();
    again.button("Show the formatting toolbar")?.click();
    expect(again.parent.querySelector(".format-controls")).not.toBeNull();
    expect(localStorage.getItem("obsidian-collab:toolbar")).toBeNull();
  });

  test("hidden or shown from the keyboard, the focus on the button that undoes it", () => {
    const { button } = setUp();
    button("Hide the formatting toolbar")?.focus();
    button("Hide the formatting toolbar")?.click();
    expect(document.activeElement).toBe(button("Show the formatting toolbar"));
    button("Show the formatting toolbar")?.click();
    expect(document.activeElement).toBe(button("Hide the formatting toolbar"));
  });

  test("hidden, it reads nothing of the selection", () => {
    const { button, select } = setUp();
    button("Hide the formatting toolbar")?.click();
    resetCounters();
    select(1, 3);
    select(4);
    expect(counter("toolbar.state")).toBe(0);
  });
});

describe("the toolbar on a narrow view", () => {
  test("the numbered list and the checklist in a More menu, which also inserts", () => {
    const { parent, editor, select, button } = setUp("edit", "- a", true);
    expect(button("Numbered list")).toBeNull();
    expect(button("Insert")).toBeNull();
    select(3);
    button("More")?.click();
    const items = Array.from(
      parent.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'),
    );
    expect(
      items
        .map((item) => [item.getAttribute("role"), item.textContent?.trim()])
        .slice(0, 3),
    ).toEqual([
      ["menuitemcheckbox", "Numbered list"],
      ["menuitemcheckbox", "Checklist"],
      ["menuitem", "Table"],
    ]);
    expect(items[1]?.getAttribute("aria-checked")).toBe("false");
    items[0]?.click();
    expect(editor.view.state.doc.toString()).toBe("1. a");
  });

  test("as the view's width changes", () => {
    const { button, narrowNow } = setUp();
    expect(button("Numbered list")).not.toBeNull();
    narrowNow(true);
    expect(button("Numbered list")).toBeNull();
    expect(button("More")).not.toBeNull();
    narrowNow(false);
    expect(button("Insert")).not.toBeNull();
  });
});

describe("the toolbar and the editor's parse", () => {
  test("read again as the parse goes on, the selection unmoved", async () => {
    // Far in a long text, the parse isn't there at first: nothing said.
    const filler = "Some *text* here.\n\n".repeat(4000);
    const { editor, select, button } = setUp("edit", `${filler}**bold**`);
    select(filler.length + 3);
    expect(button("Bold")?.getAttribute("aria-pressed")).toBe("false");
    // The editor's parse goes on in the background, by its own timers:
    // waited for until the text is parsed whole.
    while (
      !syntaxTreeAvailable(editor.view.state, editor.view.state.doc.length)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(button("Bold")?.getAttribute("aria-pressed")).toBe("true");
  }, 20_000);
});

describe("the toolbar's budget (AGENTS.md §6)", () => {
  test("a keystroke: one reading of the state", () => {
    const { editor, select } = setUp("edit", "a b c\n- d\n> e");
    select(5);
    resetCounters();
    editor.view.dispatch({
      changes: { from: 5, insert: "x" },
      selection: { anchor: 6 },
      userEvent: "input.type",
    });
    expect(counter("toolbar.state")).toBe(1);
  });

  test("the whole text selected: no more work for a text four times longer", () => {
    const work = (lines: number) => {
      const text = Array.from(
        { length: lines },
        (_, i) => `- line *${i}*`,
      ).join("\n");
      const { editor } = setUp("edit", text);
      // Parsed whole first: the state reads only what is parsed in time.
      ensureSyntaxTree(editor.view.state, text.length, 60_000);
      resetCounters();
      editor.view.dispatch({
        selection: EditorSelection.single(0, text.length),
      });
      return counter("format.line");
    };
    expect(work(150)).toBeGreaterThan(0);
    expect(work(2000)).toBeLessThanOrEqual(work(500));
  });
});
