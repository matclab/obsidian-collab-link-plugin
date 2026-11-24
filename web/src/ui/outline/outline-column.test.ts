// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDocumentEditor } from "../../editor/editor.js";
import { followEditor } from "../../outline/follow-editor.js";
import { OutlineIndex } from "../../outline/outline-index.js";
import { counter, resetCounters } from "../../perf/index.js";
import type { Mode } from "../reading/view-switch.js";
import { OUTLINE_KEY, createOutlineColumn } from "./outline-column.js";
import { OUTLINE_WIDTH_KEY } from "./outline-width.js";

const editors: { destroy(): void }[] = [];

const TEXT = "# One\n\npara\n\n## Two\n\ntext\n\n### Three\n\n# Four";

function setUp(
  options: {
    text?: string;
    wide?: boolean;
    narrow?: boolean;
    stored?: string;
    storedWidth?: string;
    /** The source line read. */
    line?: number;
  } = {},
) {
  if (options.stored) localStorage.setItem(OUTLINE_KEY, options.stored);
  if (options.storedWidth)
    localStorage.setItem(OUTLINE_WIDTH_KEY, options.storedWidth);
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, options.text ?? TEXT);
  contentDoc.commit();
  const root = document.createElement("div");
  document.body.append(root);
  const workspace = document.createElement("main");
  const aside = document.createElement("aside");
  const editorParent = document.createElement("div");
  const bar = document.createElement("div");
  editorParent.append(bar);
  const previewRoot = document.createElement("div");
  previewRoot.className = "preview";
  editorParent.append(previewRoot);
  workspace.append(aside, editorParent);
  root.append(workspace);
  const editor = createDocumentEditor(editorParent, contentDoc, {});
  editors.push(editor.view);
  const index = new OutlineIndex(editor.view.state.doc);
  followEditor(editor.view, index);
  let mode: Mode = "write";
  const modeListeners: ((mode: Mode) => void)[] = [];
  const screen = (at: boolean | undefined) => {
    let now = at ?? false;
    const listeners: (() => void)[] = [];
    return {
      query: {
        matches: () => now,
        onChange: (listener: () => void) => listeners.push(listener),
      },
      set(next: boolean) {
        now = next;
        for (const listener of listeners) listener();
      },
    };
  };
  const wide = screen(options.wide);
  const narrow = screen(options.narrow);
  const frames: (() => void)[] = [];
  const column = createOutlineColumn(aside, {
    index,
    surfaces: {
      view: editor.view,
      previewRoot,
      ownColumn: () => false,
      readingTop: () => 0,
    },
    views: {
      mode: () => mode,
      onMode: (listener) => modeListeners.push(listener),
      bar,
    },
    workspace,
    narrow: narrow.query,
    wide: wide.query,
    preferences: localStorage,
    frame: (run) => frames.push(run),
    topLine: () => options.line ?? 0,
  });
  const items = () =>
    Array.from(workspace.querySelectorAll<HTMLButtonElement>(".outline-item"));
  const drawer = () =>
    workspace.querySelector<HTMLDialogElement>("dialog.outline-drawer");
  const toggle = () =>
    bar.querySelector<HTMLButtonElement>(
      ".outline-toggle",
    ) as HTMLButtonElement;
  return {
    contentDoc,
    editor,
    index,
    aside,
    workspace,
    previewRoot,
    column,
    items,
    drawer,
    toggle,
    wide,
    narrow,
    runFrames() {
      for (const run of frames.splice(0)) run();
    },
    pendingFrames: () => frames.length,
    setMode(next: Mode) {
      mode = next;
      for (const listener of modeListeners) listener(next);
    },
    type(at: number, insert: string) {
      editor.view.dispatch({ changes: { from: at, insert } });
    },
  };
}

const microtask = () => new Promise<void>((done) => queueMicrotask(done));

// What jsdom lacks: an element brought into view (recorded), and the boxes
// CodeMirror measures once asked to scroll.
const scrolledTo: string[] = [];
const saved = {
  scrollIntoView: HTMLElement.prototype.scrollIntoView,
  rangeRects: Range.prototype.getClientRects,
  rangeBox: Range.prototype.getBoundingClientRect,
};
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledTo.push(this.textContent ?? "");
  };
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = saved.scrollIntoView;
  Range.prototype.getClientRects = saved.rangeRects;
  Range.prototype.getBoundingClientRect = saved.rangeBox;
});

afterEach(() => {
  for (const view of editors.splice(0)) view.destroy();
  localStorage.clear();
  document.body.replaceChildren();
});

describe("the outline column", () => {
  test("lists the headings, nested by level", () => {
    const { items, aside } = setUp({ wide: true });
    expect(items().map((item) => item.textContent?.trim())).toEqual([
      "One",
      "Two",
      "Three",
      "Four",
    ]);
    // Three is under Two, under One; Four on its own.
    const three = items()[2] as HTMLElement;
    expect(
      three.closest("ul")?.closest("li")?.querySelector(".outline-item")
        ?.textContent,
    ).toBe("Two");
    expect(
      aside.querySelector("nav")?.getAttribute("aria-labelledby"),
    ).toBeTruthy();
  });

  test("a heading chosen: the editor's caret on it, the editor focused", () => {
    const { items, editor } = setUp({ wide: true });
    (items()[1] as HTMLButtonElement).click();
    const at = editor.view.state.doc.toString().indexOf("## Two");
    expect(editor.view.state.selection.main.head).toBe(at);
    expect(editor.view.hasFocus).toBe(true);
  });

  test("the editor hidden: the preview's block of the heading is brought into view", () => {
    const { items, editor, previewRoot } = setUp({ wide: true });
    editor.view.dom.hidden = true;
    previewRoot.innerHTML =
      '<h1 data-line="0" data-line-end="1">One</h1><p data-line="2" data-line-end="3">para</p><h2 data-line="4" data-line-end="5">Two</h2>';
    scrolledTo.length = 0;
    (items()[1] as HTMLButtonElement).click();
    expect(scrolledTo).toEqual(["Two"]);
  });

  test("the current heading is marked, at the next frame", () => {
    const { aside, runFrames } = setUp({ wide: true });
    runFrames();
    const current = aside.querySelector('[aria-current="location"]');
    expect(current?.textContent?.trim()).toBe("One");
  });

  test("the text scrolled, the heading read is marked again", () => {
    const { runFrames, pendingFrames, editor } = setUp({ wide: true });
    runFrames();
    editor.view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(pendingFrames()).toBe(1);
  });

  // The wheel in the outline moves the outline: it is not the text read.
  test("the outline scrolled, in its column or its drawer, marks nothing again", async () => {
    const { aside, runFrames, pendingFrames } = setUp({ wide: true });
    runFrames();
    aside.dispatchEvent(new Event("scroll"));
    (aside.querySelector("nav") as HTMLElement).dispatchEvent(
      new Event("scroll"),
    );
    expect(pendingFrames()).toBe(0);
    document.body.replaceChildren();

    const narrow = setUp({ narrow: true });
    narrow.toggle().click();
    await microtask();
    narrow.runFrames();
    (narrow.drawer() as HTMLDialogElement).dispatchEvent(new Event("scroll"));
    expect(narrow.pendingFrames()).toBe(0);
  });

  // `scrollIntoView` moves every scrolled ancestor: the page too.
  test("the heading read is brought into the outline's view by the outline alone", () => {
    const { runFrames, items, aside: column } = setUp({ wide: true });
    // The list scrolls in its own box, the handle beside it (PV1).
    const aside = column.querySelector(".outline-holder") as HTMLElement;
    // jsdom scrolls nothing: a plain property.
    let scrollTop = 0;
    Object.defineProperty(aside, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    const box = (top: number, height: number) => () =>
      new DOMRect(0, top, 100, height);
    aside.getBoundingClientRect = box(100, 200);
    const one = items()[0] as HTMLElement;
    one.getBoundingClientRect = box(400, 20);
    scrolledTo.length = 0;
    runFrames();
    expect(scrolledTo).toEqual([]);
    expect(aside.scrollTop).toBe(120);
    aside.scrollTop = 500;
    one.getBoundingClientRect = box(60, 20);
    aside.dispatchEvent(new Event("scroll"));
    runFrames();
    expect(aside.scrollTop).toBe(500);
    document.dispatchEvent(new Event("scroll"));
    runFrames();
    expect(aside.scrollTop).toBe(460);
  });

  test("open by default on a wide view, closed otherwise, or without headings", () => {
    expect(setUp({ wide: true }).aside.hidden).toBe(false);
    document.body.replaceChildren();
    expect(setUp({ wide: false }).aside.hidden).toBe(true);
    document.body.replaceChildren();
    expect(setUp({ wide: true, text: "no heading" }).aside.hidden).toBe(true);
  });

  test("mounted before the text is there: its default decided once the document is open", () => {
    const { aside, column, type } = setUp({ wide: true, text: "" });
    expect(aside.hidden).toBe(true);
    type(0, "# Arrived\n\ntext");
    column.opened();
    expect(aside.hidden).toBe(false);
  });

  test("closed and opened by its buttons; the choice kept", () => {
    const { aside, toggle, workspace } = setUp({ wide: true });
    expect(workspace.classList.contains("with-outline")).toBe(true);
    // Open, it is closed from its head: no toggle over the text.
    expect(toggle().hidden).toBe(true);
    (aside.querySelector(".outline-close") as HTMLButtonElement).click();
    expect(aside.hidden).toBe(true);
    expect(workspace.classList.contains("with-outline")).toBe(false);
    expect(toggle().hidden).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(OUTLINE_KEY)).toBe("closed");
    toggle().click();
    expect(aside.hidden).toBe(false);
    expect(localStorage.getItem(OUTLINE_KEY)).toBe("open");
    document.body.replaceChildren();
    // Kept: closed on a wide view.
    localStorage.setItem(OUTLINE_KEY, "closed");
    expect(setUp({ wide: true }).aside.hidden).toBe(true);
  });

  test("only in Write: neither it nor its button in Review or History", () => {
    const { aside, toggle, setMode } = setUp({ wide: true });
    setMode("review");
    expect(aside.hidden).toBe(true);
    expect(toggle().hidden).toBe(true);
    setMode("history");
    expect(aside.hidden).toBe(true);
    setMode("write");
    expect(aside.hidden).toBe(false);
  });

  test("follows the text: a heading typed shows, once per microtask", async () => {
    const { items, type, editor } = setUp({ wide: true });
    type(editor.view.state.doc.length, "\n\n## Five");
    expect(items()).toHaveLength(4);
    await microtask();
    expect(items().map((item) => item.textContent?.trim())).toContain("Five");
  });

  test("open, a keystroke in a paragraph: one parse, nothing rendered; a heading added: one rendering", async () => {
    const { type, editor } = setUp({ wide: true });
    resetCounters();
    const at = editor.view.state.doc.toString().indexOf("para") + 2;
    type(at, "k");
    type(at + 1, "l");
    await microtask();
    expect(counter("outline.parse")).toBe(1);
    expect(counter("outline.render")).toBe(0);
    type(editor.view.state.doc.length, "\n\n## Five");
    await microtask();
    expect(counter("outline.render")).toBe(1);
  });

  test("closed, typing parses nothing", async () => {
    const { toggle, type } = setUp({ wide: true });
    toggle().click();
    resetCounters();
    type(0, "x");
    type(1, "\n# New\n");
    await microtask();
    expect(counter("outline.parse")).toBe(0);
  });

  test("narrow: a modal drawer, closed at first; a choice or Escape closes it", async () => {
    const { aside, toggle, items, drawer, narrow, workspace } = setUp({
      wide: false,
      narrow: true,
      stored: "open",
    });
    // Never open over the text at first, whatever was kept.
    expect(aside.hidden).toBe(true);
    expect(drawer()?.open).toBe(false);
    toggle().click();
    // A dialog over the text (above the view's containment, phase 16).
    expect(drawer()?.open).toBe(true);
    expect(drawer()?.contains(items()[0] as Node)).toBe(true);
    expect(aside.hidden).toBe(true);
    expect(workspace.classList.contains("with-outline")).toBe(false);
    // Opening it does not change what is kept for a wider view.
    expect(localStorage.getItem(OUTLINE_KEY)).toBe("open");
    (items()[0] as HTMLButtonElement).click();
    expect(drawer()?.open).toBe(false);
    toggle().click();
    // Focus goes into the drawer; Escape from there closes it.
    expect(drawer()?.contains(document.activeElement)).toBe(true);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(drawer()?.open).toBe(false);
    expect(document.activeElement).toBe(toggle());
    // Closed by the browser (its own Escape, a click outside): closed here.
    toggle().click();
    drawer()?.removeAttribute("open");
    drawer()?.dispatchEvent(new Event("close"));
    toggle().click();
    expect(drawer()?.open).toBe(true);
    // Wider again: the column as kept, the list back in it.
    narrow.set(false);
    expect(drawer()?.open).toBe(false);
    expect(aside.hidden).toBe(false);
    expect(aside.contains(items()[0] as Node)).toBe(true);
  });

  describe("its width (ADR-0062, PV1 to PV3)", () => {
    const handleOf = (aside: HTMLElement) =>
      aside.querySelector<HTMLElement>('[role="separator"]') as HTMLElement;
    const width = (workspace: HTMLElement) =>
      workspace.style.getPropertyValue("--outline-width");
    const press = (target: HTMLElement, key: string) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );

    test("a handle at its edge: a vertical separator of the column, in rem", () => {
      const { aside, workspace } = setUp({ wide: true });
      const handle = handleOf(aside);
      expect(handle.getAttribute("aria-orientation")).toBe("vertical");
      expect(handle.getAttribute("aria-controls")).toBe(aside.id);
      expect(handle.getAttribute("aria-valuenow")).toBe("15");
      expect(handle.getAttribute("aria-valuemin")).toBe("12");
      expect(handle.getAttribute("aria-valuemax")).toBe("28");
      expect(handle.getAttribute("aria-label")).toBeTruthy();
      expect(handle.tabIndex).toBe(0);
      // Outside the list, which scrolls alone.
      expect(aside.querySelector(".outline-holder")?.contains(handle)).toBe(
        false,
      );
      expect(width(workspace)).toBe("");
    });

    test("by the keyboard: arrows by one rem, Home and End, Enter back to the default; kept", () => {
      const { aside, workspace } = setUp({ wide: true });
      const handle = handleOf(aside);
      press(handle, "ArrowRight");
      press(handle, "ArrowRight");
      expect(width(workspace)).toBe("17rem");
      expect(handle.getAttribute("aria-valuenow")).toBe("17");
      expect(localStorage.getItem(OUTLINE_WIDTH_KEY)).toBe("17");
      press(handle, "Home");
      expect(width(workspace)).toBe("12rem");
      press(handle, "End");
      expect(width(workspace)).toBe("28rem");
      press(handle, "Enter");
      expect(width(workspace)).toBe("");
      expect(handle.getAttribute("aria-valuenow")).toBe("15");
      expect(localStorage.getItem(OUTLINE_WIDTH_KEY)).toBeNull();
    });

    test("by the pointer: the column's edge follows it, kept once let go; a double click resets it", () => {
      const { aside, workspace } = setUp({ wide: true });
      const handle = handleOf(aside);
      aside.getBoundingClientRect = () => new DOMRect(100, 0, 240, 500);
      const pointer = (type: string, clientX: number) =>
        handle.dispatchEvent(
          new MouseEvent(type, { clientX, bubbles: true, button: 0 }),
        );
      pointer("pointerdown", 340);
      pointer("pointermove", 420);
      expect(width(workspace)).toBe("20rem");
      expect(localStorage.getItem(OUTLINE_WIDTH_KEY)).toBeNull();
      pointer("pointermove", 2000);
      expect(width(workspace)).toBe("28rem");
      pointer("pointermove", 404);
      pointer("pointerup", 404);
      expect(width(workspace)).toBe("19rem");
      expect(localStorage.getItem(OUTLINE_WIDTH_KEY)).toBe("19");
      // Let go, the pointer moves nothing.
      pointer("pointermove", 600);
      expect(width(workspace)).toBe("19rem");
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(width(workspace)).toBe("");
      expect(localStorage.getItem(OUTLINE_WIDTH_KEY)).toBeNull();
    });

    test("the width kept is the one shown; one unreadable is ignored", () => {
      const kept = setUp({ wide: true, storedWidth: "21" });
      expect(width(kept.workspace)).toBe("21rem");
      expect(handleOf(kept.aside).getAttribute("aria-valuenow")).toBe("21");
      document.body.replaceChildren();
      localStorage.clear();
      const odd = setUp({ wide: true, storedWidth: "300" });
      expect(width(odd.workspace)).toBe("");
      expect(handleOf(odd.aside).getAttribute("aria-valuenow")).toBe("15");
    });

    test("not in the drawer", () => {
      const { toggle, drawer } = setUp({ narrow: true });
      toggle().click();
      expect(drawer()?.querySelector('[role="separator"]')).toBeNull();
    });
  });

  describe("folding (ADR-0062, PV4 to PV8)", () => {
    // Part (Chapter (Section, Section), Chapter), Other.
    const LONG =
      "# Part\n\n## Chapter A\n\n### Section A1\n\n### Section A2\n\n## Chapter B\n\n# Other";
    const texts = (items: HTMLButtonElement[]) =>
      items.map((item) => item.textContent?.trim());
    const chevronOf = (item: HTMLElement) =>
      item
        .closest("li")
        ?.querySelector<HTMLButtonElement>(
          ":scope > .outline-row > .outline-fold",
        );

    test("a chevron on each heading with children, none on the others", () => {
      const { items } = setUp({ wide: true, text: LONG });
      const chevrons = items().map((item) => chevronOf(item));
      expect(
        chevrons.map((chevron) => chevron?.getAttribute("aria-expanded")),
      ).toEqual(["true", "true", undefined, undefined, undefined, undefined]);
      const first = chevrons[0] as HTMLButtonElement;
      expect(first.getAttribute("aria-label")).toContain("Part");
      // Out of the tab order: the arrows fold from the heading.
      expect(first.tabIndex).toBe(-1);
    });

    test("folded: its headings no longer shown, their count by its side; unfolded again", () => {
      const { items } = setUp({ wide: true, text: LONG });
      const chapter = chevronOf(items()[1] as HTMLElement) as HTMLButtonElement;
      chapter.click();
      expect(texts(items())).toEqual([
        "Part",
        "Chapter A",
        "Chapter B",
        "Other",
      ]);
      expect(chapter.getAttribute("aria-expanded")).toBe("false");
      expect(chapter.getAttribute("aria-label")).toContain("2");
      const row = (items()[1] as HTMLElement).closest(".outline-row");
      expect(row?.querySelector(".outline-count")?.textContent?.trim()).toBe(
        "2",
      );
      chapter.click();
      expect(items()).toHaveLength(6);
      expect(row?.querySelector(".outline-count")).toBeNull();
    });

    test("Alt+click: every heading of its depth folded, then unfolded", () => {
      const text = "# A\n\n## A1\n\n### A1a\n\n# B\n\n## B1\n\n# C";
      const { items } = setUp({ wide: true, text });
      const chevron = chevronOf(items()[0] as HTMLElement) as HTMLButtonElement;
      chevron.dispatchEvent(
        new MouseEvent("click", { altKey: true, bubbles: true }),
      );
      expect(texts(items())).toEqual(["A", "B", "C"]);
      chevron.dispatchEvent(
        new MouseEvent("click", { altKey: true, bubbles: true }),
      );
      expect(texts(items())).toEqual(["A", "A1", "A1a", "B", "B1", "C"]);
    });

    test("« Levels »: 1 to the tree's depth, each an action; none under two", () => {
      const { aside, items } = setUp({ wide: true, text: LONG });
      const levels = () =>
        Array.from(
          aside.querySelectorAll<HTMLButtonElement>(".outline-levels button"),
        );
      expect(levels().map((button) => button.textContent?.trim())).toEqual([
        "1",
        "2",
        "3",
      ]);
      expect(levels()[1]?.getAttribute("aria-label")).toBeTruthy();
      (levels()[0] as HTMLButtonElement).click();
      expect(texts(items())).toEqual(["Part", "Other"]);
      (levels()[1] as HTMLButtonElement).click();
      expect(texts(items())).toEqual([
        "Part",
        "Chapter A",
        "Chapter B",
        "Other",
      ]);
      // An action, not a filter: a branch unfolded by hand after it.
      (chevronOf(items()[1] as HTMLElement) as HTMLButtonElement).click();
      expect(items()).toHaveLength(6);
      (levels()[2] as HTMLButtonElement).click();
      expect(items()).toHaveLength(6);
      document.body.replaceChildren();
      const flat = setUp({ wide: true, text: "# One\n\n# Two" });
      expect(flat.aside.querySelector(".outline-levels")).toBeNull();
    });

    test("the heading read under a folded branch: its shown ancestor marked (PV7)", () => {
      // The line read: Section A2's.
      const { items, aside, runFrames } = setUp({
        wide: true,
        text: LONG,
        line: 6,
      });
      const marked = () =>
        aside.querySelector('[aria-current="location"]')?.textContent?.trim();
      runFrames();
      expect(marked()).toBe("Section A2");
      (chevronOf(items()[0] as HTMLElement) as HTMLButtonElement).click();
      expect(marked()).toBe("Part");
    });

    test("a heading added above by another: the folded one stays folded (PV6)", async () => {
      const { items, type } = setUp({ wide: true, text: LONG });
      (chevronOf(items()[1] as HTMLElement) as HTMLButtonElement).click();
      expect(items()).toHaveLength(4);
      type(0, "# New\n\n");
      await microtask();
      expect(texts(items())).toEqual([
        "New",
        "Part",
        "Chapter A",
        "Chapter B",
        "Other",
      ]);
    });

    test("arrows: right unfolds then goes to the first child; left folds then goes to the parent", () => {
      const { items } = setUp({ wide: true, text: LONG });
      const press = (key: string) =>
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      (items()[1] as HTMLButtonElement).focus();
      press("ArrowLeft");
      expect(items()).toHaveLength(4);
      expect(document.activeElement).toBe(items()[1]);
      press("ArrowLeft");
      expect(document.activeElement).toBe(items()[0]);
      (items()[1] as HTMLButtonElement).focus();
      press("ArrowRight");
      expect(items()).toHaveLength(6);
      expect(document.activeElement).toBe(items()[1]);
      press("ArrowRight");
      expect(document.activeElement?.textContent?.trim()).toBe("Section A1");
      // A leaf: right does nothing.
      press("ArrowRight");
      expect(document.activeElement?.textContent?.trim()).toBe("Section A1");
    });
  });

  // The weights and tints themselves are seen in Chromium (35d): jsdom
  // computes no style from the component's sheet.
  test("each heading carries its depth in the tree; the hierarchy marked only from two depths (PV9)", () => {
    const { items, aside } = setUp({
      wide: true,
      text: "## Opens with two\n\n#### Four\n\n## Two again",
    });
    expect(items().map((item) => item.dataset.depth)).toEqual(["1", "2", "1"]);
    expect(
      aside.querySelector("nav")?.classList.contains("outline-tiered"),
    ).toBe(true);
    document.body.replaceChildren();
    const flat = setUp({ wide: true, text: "# One\n\n# Two" });
    expect(
      flat.aside.querySelector("nav")?.classList.contains("outline-tiered"),
    ).toBe(false);
  });

  test("arrows move between the headings", () => {
    const { items, aside } = setUp({ wide: true });
    const press = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    (items()[0] as HTMLButtonElement).focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items()[0]);
    expect(aside.contains(document.activeElement)).toBe(true);
  });
});
