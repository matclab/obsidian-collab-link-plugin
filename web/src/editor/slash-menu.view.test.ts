// @vitest-environment jsdom
// The / menu on screen (phase 20c.3): a list under the caret, said to a
// screen reader from the text, chosen by a click; closed when the text
// loses the focus; no cost to a keystroke that isn't a /.
import { EditorSelection } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import { createDocumentEditor } from "./editor.js";
import { slashState } from "./slash-menu.js";
import { withoutLayout } from "./test-support/no-layout.js";

const destroyed = withoutLayout();

function setUp(text = "") {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createDocumentEditor(parent, doc);
  destroyed(editor.view);
  const view = editor.view;
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
  return { view, type, list, parent };
}

describe("the / menu on screen", () => {
  test("a list of the matches, the active one said from the text", () => {
    const { view, type, list } = setUp();
    type("/tab");
    const options = Array.from(
      list()?.querySelectorAll('[role="option"]') ?? [],
    );
    expect(options.map((option) => option.textContent)).toEqual(["Table"]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    // As CodeMirror's completion says it: aria-expanded isn't allowed
    // on a textbox (axe, check:ui).
    expect(view.contentDOM.getAttribute("aria-haspopup")).toBe("listbox");
    expect(view.contentDOM.getAttribute("aria-autocomplete")).toBe("list");
    expect(view.contentDOM.getAttribute("aria-controls")).toBe(list()?.id);
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(
      options[0]?.id,
    );
    type("z");
    expect(list()).toBeNull();
    expect(view.contentDOM.hasAttribute("aria-expanded")).toBe(false);
    expect(view.contentDOM.hasAttribute("aria-controls")).toBe(false);
    expect(view.contentDOM.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("ten options shown at most, the window following the active one", () => {
    const { view, type, list } = setUp();
    type("/");
    const shown = () =>
      Array.from(list()?.querySelectorAll('[role="option"]') ?? []).map(
        (option) => [
          option.textContent,
          option.getAttribute("aria-posinset"),
          option.getAttribute("aria-selected"),
        ],
      );
    const all = slashState(view.state)?.matches.length ?? 0;
    expect(all).toBeGreaterThan(10);
    expect(shown()).toHaveLength(10);
    expect(
      list()?.querySelector('[role="option"]')?.getAttribute("aria-setsize"),
    ).toBe(String(all));
    for (let i = 0; i < 12; i++)
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
    expect(shown()).toHaveLength(10);
    expect(shown().at(-1)).toEqual(["Bulleted list", "13", "true"]);
  });

  test("a click on an option chooses it, the focus kept in the text", () => {
    const { view, type, list } = setUp("a\n");
    type("/tab");
    const option = list()?.querySelector<HTMLElement>('[role="option"]');
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    option?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "a\n\n|  |  |\n| --- | --- |\n|  |  |",
    );
    expect(list()).toBeNull();
  });

  test("closed when the text loses the focus", () => {
    vi.useFakeTimers();
    try {
      const { view, type, list, parent } = setUp();
      type("/");
      expect(list()).not.toBeNull();
      const other = document.createElement("button");
      parent.append(other);
      other.focus();
      // CodeMirror tells a focus change in a timer of its own.
      vi.runOnlyPendingTimers();
      expect(slashState(view.state)).toBeNull();
      expect(list()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a keystroke that isn't a / looks at nothing (WA6)", () => {
    const { type } = setUp("some text ");
    resetCounters();
    type("abc def ");
    expect(counter("slash.open")).toBe(0);
    type("/");
    expect(counter("slash.open")).toBe(1);
  });
});
