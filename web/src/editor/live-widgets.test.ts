// @vitest-environment jsdom
// A task's box in the formatted text (phase 11, decision 8): an editor
// ticks it with a click — an edit like any other, undoable; a link that
// may not write sees it read only; the click never moves the caret.
import { undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import { countDuring } from "../perf/index.js";
import { calloutIcon } from "../render/index.js";
import type { KatexModule } from "../view-model/katex.js";
import { createDocumentEditor } from "./editor.js";

// Destroyed after each test: a view still attached measures itself on the
// next animation frame, which jsdom cannot do.
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

function setUp(
  text: string,
  readOnly = false,
  katex?: () => Promise<KatexModule>,
) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const { view } = createDocumentEditor(parent, doc, {
    livePreview: true,
    readOnly,
    ...(katex && { katex }),
  });
  views.push(view);
  // Parsed to the end: under load, the parser stops at its time budget.
  forceParsing(view, view.state.doc.length, 5000);
  const boxes = () =>
    Array.from(
      view.contentDOM.querySelectorAll<HTMLInputElement>("input.cm-live-task"),
    );
  return { doc, view, boxes };
}

describe("a task's box", () => {
  test("shows the marker's state, with a name", () => {
    const { boxes } = setUp("- [ ] a\n- [x] b");
    expect(boxes().map((box) => box.checked)).toEqual([false, true]);
    expect(boxes()[0]?.getAttribute("aria-label")).toBe("Task");
  });

  test("an editor ticks it: the text changes, in Loro too, and undo restores it", () => {
    const { doc, view, boxes } = setUp("- [ ] a\n- [x] b");
    const selection = view.state.selection;
    boxes()[0]?.click();
    expect(view.state.doc.toString()).toBe("- [x] a\n- [x] b");
    expect(doc.getText("content").toString()).toBe("- [x] a\n- [x] b");
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(boxes().map((box) => box.checked)).toEqual([true, true]);

    boxes()[1]?.click();
    expect(view.state.doc.toString()).toBe("- [x] a\n- [ ] b");
    undo(view);
    expect(view.state.doc.toString()).toBe("- [x] a\n- [x] b");
  });

  test("read only for a link that may not write, drawn as an editor's: not greyed out", () => {
    const { view, boxes } = setUp("- [ ] a\n- [x] b", true);
    // `disabled` would grey it out, an unticked box almost unseen (in
    // Review too); read only is told otherwise.
    expect(boxes().map((box) => box.disabled)).toEqual([false, false]);
    expect(boxes().map((box) => box.getAttribute("aria-disabled"))).toEqual([
      "true",
      "true",
    ]);
    boxes()[0]?.click();
    boxes()[1]?.click();
    expect(view.state.doc.toString()).toBe("- [ ] a\n- [x] b");
    expect(boxes().map((box) => box.checked)).toEqual([false, true]);
  });
});

/** A KaTeX whose loading the test ends, and whose rendering it can read. */
function controlledKatex() {
  let finish: (katex: KatexModule) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const loading = new Promise<KatexModule>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const katex: KatexModule = {
    renderToString: (tex: string, options?: { displayMode?: boolean }) =>
      `<b class="tex" data-display="${options?.displayMode}">${tex}</b>`,
  } as KatexModule;
  return { load: () => loading, finish: () => finish(katex), fail };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("a formula", () => {
  test("shows its source until KaTeX is loaded, then its rendering", async () => {
    const katex = controlledKatex();
    const { view } = setUp("Soit $a_1$ et $$b_1$$.", false, katex.load);
    const formulas = () =>
      Array.from(view.contentDOM.querySelectorAll(".cm-live-math"));
    expect(formulas().map((element) => element.textContent)).toEqual([
      "a_1",
      "b_1",
    ]);
    katex.finish();
    await settle();
    expect(
      formulas().map((element) => element.querySelector(".tex")?.outerHTML),
    ).toEqual([
      '<b class="tex" data-display="false">a_1</b>',
      '<b class="tex" data-display="true">b_1</b>',
    ]);
  });

  test("an unchanged formula costs no KaTeX when the text changes elsewhere", async () => {
    const katex = controlledKatex();
    const { view } = setUp("Soit $a_2$.\n\nFin", false, katex.load);
    katex.finish();
    await settle();
    const before = view.contentDOM.querySelector(".cm-live-math");
    const renders = countDuring("katex.render", () =>
      view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }),
    );
    await settle();
    expect(renders).toBe(0);
    // Not drawn again: the same element.
    expect(view.contentDOM.querySelector(".cm-live-math")).toBe(before);
  });

  test("a failed load leaves its source, and no error", async () => {
    const katex = controlledKatex();
    const { view } = setUp("Soit $a_3$.", false, katex.load);
    katex.fail(new Error("offline"));
    await settle();
    expect(view.contentDOM.querySelector(".cm-live-math")?.textContent).toBe(
      "a_3",
    );
  });

  test("a widget gone before the load ends receives nothing", async () => {
    const katex = controlledKatex();
    const { view } = setUp("Soit $a_4$.", false, katex.load);
    const element = view.contentDOM.querySelector(".cm-live-math");
    // The formula's line touched, with the focus: its source again.
    view.focus();
    view.dispatch({ selection: { anchor: 1 } });
    expect(view.contentDOM.querySelector(".cm-live-math")).toBeNull();
    const renders = countDuring("katex.render", () => katex.finish());
    await settle();
    expect(renders + Number(element?.querySelector(".tex") !== null)).toBe(0);
  });
});

describe("an embedded image", () => {
  test("is drawn, with its text", () => {
    const png = "data:image/png;base64,AAAA";
    const { view } = setUp(`![logo](${png})`);
    const image =
      view.contentDOM.querySelector<HTMLImageElement>("img.cm-live-image");
    expect(image?.getAttribute("src")).toBe(png);
    expect(image?.alt).toBe("logo");
  });
});

describe("a callout's header (phase 15, decisions 5 and 6)", () => {
  test("its family's icon, hidden from screen readers, then its default title when it has none", () => {
    const { view } = setUp("> [!faq]\n> x\n\n> [!bug] Titre\n> y\n\nfin");
    // The icon as the browser reads it.
    const drawn = (family: "question" | "bug") => {
      const holder = document.createElement("span");
      holder.innerHTML = calloutIcon(family);
      return holder.innerHTML;
    };
    expect(
      Array.from(
        view.contentDOM.querySelectorAll(".cm-live-callout-header"),
        (header) => [
          header.querySelector(".cm-live-callout-icon")?.innerHTML,
          header.textContent,
        ],
      ),
    ).toEqual([
      [drawn("question"), "Faq"],
      [drawn("bug"), ""],
    ]);
    expect(calloutIcon("bug")).toContain('aria-hidden="true"');
  });
});
