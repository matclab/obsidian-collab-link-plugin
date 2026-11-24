// @vitest-environment jsdom
// The block widgets in an editor (phase 11d): tables and formula blocks
// rendered, a block touched with the focus shown as its source, links in a
// table not followed by a plain click, and their budget.

import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import { countDuring } from "../perf/index.js";
import type { KatexModule } from "../view-model/katex.js";
import { createDocumentEditor } from "./editor.js";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

const rendered: { tex: string; display: boolean }[] = [];
const katex: KatexModule = {
  renderToString: (tex: string, options?: { displayMode?: boolean }) => {
    rendered.push({ tex, display: options?.displayMode ?? false });
    return `<b class="tex">${tex}</b>`;
  },
} as KatexModule;

function setUp(text: string) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const { view } = createDocumentEditor(parent, doc, {
    livePreview: true,
    katex: () => Promise.resolve(katex),
  });
  views.push(view);
  // Parsed to the end: under load, the parser stops at its time budget.
  forceParsing(view, view.state.doc.length, 5000);
  return view;
}

const settle = () => new Promise((done) => setTimeout(done, 0));
const TABLE =
  "| a | b |\n|---|---|\n| 1 | $y_{t}$ |\n| [lien](https://x.org) | 2 |";

describe("block widgets", () => {
  test("a formula block in a list in a quote: drawn, in its place", async () => {
    rendered.length = 0;
    const view = setUp("> - item\n>\n>   $$\n>   x^2\n>   $$");
    await settle();
    const block = view.contentDOM
      .querySelector(".cm-live-math-display")
      ?.closest<HTMLElement>(".cm-live-block-item");
    expect(block?.classList.contains("cm-live-block-quoted")).toBe(true);
    expect(block?.style.getPropertyValue("--li-depth")).toBe("0");
    expect(rendered.map((r) => r.tex.trim())).toEqual(["x^2"]);
  });

  test("a block on its item's first line draws the item's marker", async () => {
    const view = setUp("- | a |\n  |---|\n  | 1 |\n\n2. $$\n   x\n   $$");
    await settle();
    expect(
      Array.from(
        view.contentDOM.querySelectorAll(".cm-live-block-marker"),
        (marker) => marker.textContent,
      ),
    ).toEqual(["•", "2."]);
  });

  test("a formula block put in a quote is drawn again, in its place", async () => {
    const view = setUp("$$\nx\n$$");
    await settle();
    const quoted = () =>
      view.contentDOM
        .querySelector(".cm-live-math-display")
        ?.closest(".cm-live-block-quoted") != null;
    expect(quoted()).toBe(false);
    view.dispatch({
      changes: [0, 3, 5].map((line) => ({
        from: view.state.doc.line(1).from + line,
        insert: "> ",
      })),
    });
    expect(view.state.doc.toString()).toBe("> $$\n> x\n> $$");
    await settle();
    expect(quoted()).toBe(true);
  });

  test("a table in a quote keeps the quote's rule, one in a list item hangs under its text", async () => {
    const view = setUp(
      "> | a |\n> |---|\n> | 1 |\n\n- item\n\n  - sous\n\n    | b |\n    |---|\n    | 2 |",
    );
    await settle();
    const tables = Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>(".cm-live-table"),
    );
    expect(
      tables.map((table) => table.querySelector("th")?.textContent),
    ).toEqual(["a", "b"]);
    expect(
      tables.map((table) => table.classList.contains("cm-live-block-quoted")),
    ).toEqual([true, false]);
    expect(
      tables.map((table) => table.style.getPropertyValue("--li-depth")),
    ).toEqual(["", "1"]);
  });

  test("a block in a callout takes its colour, without a quote's rule; under a plain quote in it, the rule too (phase 15, decision 9)", async () => {
    const view = setUp(
      "> [!warning] T\n> | a |\n> |---|\n> | 1 |\n\n> [!tip]\n> > | b |\n> > |---|\n\nfin",
    );
    await settle();
    const tables = Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>(".cm-live-table"),
    );
    expect(
      tables.map((table) => [
        table.classList.contains("cm-live-block-callout"),
        table.classList.contains("cm-live-block-quoted"),
        table.style.getPropertyValue("--md-callout-color"),
      ]),
    ).toEqual([
      [true, false, "var(--md-callout-warning)"],
      [true, true, "var(--md-callout-tip)"],
    ]);
  });

  test("a formula block moved into a callout is drawn again, in its colour", async () => {
    const view = setUp("> q\n>\n> $$\n> x\n> $$");
    await settle();
    const block = () =>
      view.contentDOM
        .querySelector(".cm-live-math-display")
        ?.closest<HTMLElement>(".cm-live-block-quoted");
    expect(block()?.classList.contains("cm-live-block-callout")).toBe(false);
    view.dispatch({ changes: { from: 2, to: 3, insert: "[!bug]" } });
    forceParsing(view, view.state.doc.length, 5000);
    await settle();
    const callout = view.contentDOM
      .querySelector(".cm-live-math-display")
      ?.closest<HTMLElement>(".cm-live-block-callout");
    expect(callout?.style.getPropertyValue("--md-callout-color")).toBe(
      "var(--md-callout-bug)",
    );
  });

  test("a table is drawn as a table, its formulas rendered", async () => {
    const view = setUp(`Avant.\n\n${TABLE}\n\nAprès.`);
    await settle();
    const table = view.contentDOM.querySelector(".cm-live-table table");
    expect(
      Array.from(table?.querySelectorAll("th, td") ?? [], (cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(["a", "b", "1", "y_{t}", "lien", "2"]);
    expect(table?.querySelector(".tex")?.textContent).toBe("y_{t}");
    // Its source lines are not drawn.
    expect(view.contentDOM.textContent).not.toContain("|---|");
  });

  test("with the focus and the caret in it, a table is its source", async () => {
    const view = setUp(`Avant.\n\n${TABLE}\n\nAprès.`);
    view.focus();
    // CodeMirror reports a change of focus a little later.
    await new Promise((done) => setTimeout(done, 50));
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf("| a") + 2 },
    });
    expect(view.contentDOM.querySelector(".cm-live-table")).toBeNull();
    expect(view.contentDOM.textContent).toContain("|---|");
  });

  test("a formula block is rendered displayed, with its number", async () => {
    rendered.length = 0;
    const view = setUp("Avant.\n\n$$\nz_{k}\n$$ (7)\n\nAprès.");
    await settle();
    expect(rendered).toContainEqual({
      tex: "\nz_{k}\n\\tag{7}",
      display: true,
    });
    expect(
      view.contentDOM.querySelector("div.cm-live-math .tex"),
    ).not.toBeNull();
  });

  test("a plain click on a link in a table is not followed; Ctrl+click is", () => {
    const view = setUp(TABLE);
    const link =
      view.contentDOM.querySelector<HTMLAnchorElement>(".cm-live-table a");
    expect(link?.target).toBe("_blank");
    const click = (init: MouseEventInit) => {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      link?.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click({})).toBe(true);
    expect(click({ ctrlKey: true })).toBe(false);
  });

  test("a link of the table that stays in the document is never followed, even with Ctrl", () => {
    // It would open the page's address in a new tab, without its key
    // (decision 9: never followed in the editor).
    const view = setUp(
      "| a | b |\n|---|---|\n| [ici](#titre) | [là](page.md) |",
    );
    for (const link of Array.from(
      view.contentDOM.querySelectorAll<HTMLAnchorElement>(".cm-live-table a"),
    )) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, link.getAttribute("href") ?? "").toBe(
        true,
      );
    }
  });

  test("an update that changes none of what they read costs nothing; a keystroke one computation", () => {
    const view = setUp(`${TABLE}\n\nfin`);
    const effect = StateEffect.define<null>();
    expect(
      countDuring("live.blocks", () =>
        view.dispatch({ effects: effect.of(null) }),
      ),
    ).toBe(0);
    expect(
      countDuring("live.blocks", () =>
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "!" },
        }),
      ),
    ).toBe(1);
  });
});
