// @vitest-environment jsdom
// The margin (phase 10, decisions 7 and 8): cards level with their
// passages on a wide screen; a compact sheet at the bottom on a narrow one
// or with the margin hidden.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  createAnnotation,
  updateStatus,
} from "../../../lib/src/annotations/index.js";
import { attachAnnotationDecorations } from "../../editor/annotation-decorations.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { withoutLayout } from "../../editor/test-support/no-layout.js";
import { counter, resetCounters } from "../../perf/index.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import type { Preview } from "../reading/preview.js";
import { createAnnotationsPanel } from "./annotations-panel.js";
import { attachMargin } from "./margin.js";

afterEach(() => document.body.replaceChildren());
beforeEach(() => resetCounters());

// A card's annotated text shown scrolls its passage into view (phase 27).
const destroyAfter = withoutLayout();

const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setUp(
  narrow = false,
  sideAtFirst?: boolean,
  /** The preview shown alone, in the margin's layout: its blocks. */
  previewRoot?: HTMLElement,
) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "one\ntwo\nthree\nfour");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  for (const [start, end] of [
    [0, 3],
    [8, 13],
  ] as const) {
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start,
      end,
      author: "bob",
    });
  }
  const workspace = document.createElement("main");
  const editorParent = document.createElement("div");
  const panelParent = document.createElement("aside");
  const bar = document.createElement("div");
  workspace.append(editorParent, panelParent);
  editorParent.append(bar);
  document.body.append(workspace);
  const editor = createDocumentEditor(editorParent, contentDoc);
  destroyAfter(editor.view);
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const active = new ActiveAnnotation();
  attachAnnotationDecorations(editor.view, index, active);
  const panel = createAnnotationsPanel(
    panelParent,
    editor,
    index,
    () => "alice",
    new LocalDecisions(log, () => {}),
    () => {},
    "edit",
    active,
  );
  let isNarrow = narrow;
  const listeners: (() => void)[] = [];
  // The view switch, as far as the margin reads it: side by side or not.
  let side = sideAtFirst ?? false;
  const modeListeners: ((mode: "write") => void)[] = [];
  const views =
    sideAtFirst === undefined && !previewRoot
      ? undefined
      : {
          mode: () => "write" as const,
          sideBySide: () => side,
          onMode(listener: (mode: "write") => void) {
            modeListeners.push(listener);
          },
          preview: {
            visible: side || previewRoot !== undefined,
            root: previewRoot ?? document.createElement("div"),
            onRendered() {},
          } as unknown as Preview,
        };
  attachMargin({
    view: editor.view,
    panel,
    index,
    bar,
    workspace,
    keys: document,
    narrow: {
      matches: () => isNarrow,
      onChange: (listener) => listeners.push(listener),
    },
    ...(views && { views }),
  });
  const measure = () => {
    (editor.view as unknown as { measure(): void }).measure();
    flushSync();
  };
  const cards = () =>
    Array.from(panelParent.querySelectorAll<HTMLElement>(".annotation-item"));
  const toggle = () => bar.querySelector<HTMLButtonElement>(".margin-toggle");
  return {
    contentDoc,
    annotationsDoc,
    editor,
    panel,
    panelParent,
    workspace,
    active,
    measure,
    cards,
    toggle,
    sideNow(next: boolean) {
      side = next;
      for (const listener of modeListeners) listener("write");
      flushSync();
    },
    narrowNow(next: boolean) {
      isNarrow = next;
      for (const listener of listeners) listener();
      flushSync();
    },
  };
}

describe("the margin", () => {
  test("on a wide screen, each card placed level with its passage, in order", () => {
    const { panelParent, measure, cards } = setUp();
    measure();
    expect(panelParent.querySelector(".layout-margin")).not.toBeNull();
    const tops = cards().map((card) => Number.parseFloat(card.style.top));
    expect(tops.every((top) => Number.isFinite(top))).toBe(true);
    expect(tops[0]).toBeLessThan(tops[1] ?? 0);
    expect(counter("margin.layout")).toBeGreaterThan(0);
  });

  // jsdom lays nothing out: every edit changes the lines' estimated
  // heights. That a keystroke within a line places nothing is checked in
  // Chromium (counters of ?perf, docs/phase-10-interface.md, 10c.4).
  test("ten keystrokes place the cards once per measure; an annotation more, once", async () => {
    const { editor, contentDoc, annotationsDoc, measure } = setUp();
    measure();
    resetCounters();
    for (let i = 0; i < 10; i++) {
      editor.view.dispatch({
        changes: { from: 2, insert: "x" },
        userEvent: "input.type",
      });
    }
    measure();
    expect(counter("margin.layout")).toBeLessThanOrEqual(1);

    resetCounters();
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 25,
      end: 28,
      author: "bob",
    });
    await notified();
    measure();
    measure();
    expect(counter("margin.layout")).toBe(1);
  });

  // A reply's field made taller by hand: the cards below move down, not
  // over it; a card resized to the height it was placed with, nothing.
  test("a card grown in place pushes the cards below it", () => {
    const observers: { observed: Set<Element>; resize(): void }[] = [];
    class Observer {
      observed = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(element: Element) {
        this.observed.add(element);
      }
      unobserve(element: Element) {
        this.observed.delete(element);
      }
      disconnect() {
        this.observed.clear();
      }
      resize() {
        const entries = [...this.observed].map((target) => ({ target }));
        this.callback(entries as never, this as never);
      }
    }
    vi.stubGlobal("ResizeObserver", Observer);
    try {
      const { measure, cards } = setUp();
      const heights = new Map<Element, number>();
      for (const card of cards()) {
        heights.set(card, 40);
        Object.defineProperty(card, "offsetHeight", {
          get: () => heights.get(card) ?? 0,
        });
      }
      measure();
      const topOf = (card?: HTMLElement) =>
        Number.parseFloat(card?.style.top ?? "");
      // The one higher on the page, then the other.
      const [first, second] = cards().sort((x, y) => topOf(x) - topOf(y));
      expect(topOf(second)).toBeLessThan(topOf(first) + 500);
      expect(observers.flatMap((o) => [...o.observed])).toContain(first);

      resetCounters();
      for (const observer of observers) observer.resize();
      measure();
      expect(counter("margin.layout")).toBe(0);

      if (first) heights.set(first, 500);
      for (const observer of observers) observer.resize();
      measure();
      expect(topOf(second)).toBeGreaterThanOrEqual(topOf(first) + 500);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("hidden by its toggle, the cards go to the sheet, which a mark opens", () => {
    // A mark is read at the press, made active at the release.
    const clickOn = (mark: Element | null) => {
      for (const type of ["mousedown", "mouseup"])
        mark?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    };
    const { toggle, panelParent, workspace, editor } = setUp();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
    toggle()?.click();
    flushSync();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
    expect(workspace.classList.contains("margin-hidden")).toBe(true);
    const sheet = () => panelParent.querySelector<HTMLElement>(".layout-sheet");
    expect(sheet()?.hidden).toBe(true);

    clickOn(editor.view.dom.querySelector(".cm-annotation-deletion"));
    flushSync();
    expect(sheet()?.hidden).toBe(false);
    expect(sheet()?.querySelectorAll(".annotation-item")).toHaveLength(1);

    // Closed, its mark, still the active one, opens it again.
    sheet()?.querySelector<HTMLButtonElement>(".sheet-close")?.click();
    flushSync();
    expect(sheet()?.hidden).toBe(true);
    clickOn(editor.view.dom.querySelector(".cm-annotation-deletion"));
    flushSync();
    expect(sheet()?.hidden).toBe(false);
  });

  test("on a narrow screen, a sheet: one card at a time, the next, or all", () => {
    const { toggle, panelParent, active, narrowNow } = setUp(true);
    const sheet = () => panelParent.querySelector<HTMLElement>(".layout-sheet");
    expect(toggle()?.textContent?.trim()).toBe("Annotations (2)");
    toggle()?.click();
    flushSync();
    expect(sheet()?.hidden).toBe(false);
    const shown = () =>
      Array.from(
        sheet()?.querySelectorAll<HTMLElement>(".annotation-item") ?? [],
        (card) => card.dataset.id,
      );
    const [first] = shown();
    sheet()?.querySelector<HTMLButtonElement>('[aria-label="Next"]')?.click();
    flushSync();
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).not.toBe(first);
    expect(active.id).toBe(shown()[0]);
    sheet()?.querySelector<HTMLButtonElement>(".sheet-all")?.click();
    flushSync();
    expect(shown()).toHaveLength(2);

    narrowNow(false);
    expect(panelParent.querySelector(".layout-margin")).not.toBeNull();
  });

  // Phase 11, decision 11: the rendering takes the margin's place.
  test("side by side, on a wide screen, the sheet; the margin again after", () => {
    const { toggle, panelParent, workspace, sideNow } = setUp(false, true);
    const sheet = () => panelParent.querySelector<HTMLElement>(".layout-sheet");
    expect(sheet()).not.toBeNull();
    expect(workspace.classList.contains("margin-hidden")).toBe(true);
    expect(toggle()?.textContent?.trim()).toBe("Annotations (2)");
    expect(toggle()?.hasAttribute("aria-pressed")).toBe(false);
    toggle()?.click();
    flushSync();
    expect(sheet()?.hidden).toBe(false);

    sideNow(false);
    expect(panelParent.querySelector(".layout-margin")).not.toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("a closed card whose text is shown, the preview alone (phase 27)", () => {
  test("in front of the preview's block that holds its line, that block brought into view", async () => {
    // One block a line, 100 px apart.
    const root = document.createElement("div");
    const scrolled: string[] = [];
    for (let line = 0; line < 4; line++) {
      const block = document.createElement("p");
      block.dataset.line = String(line);
      block.dataset.lineEnd = String(line + 1);
      block.getBoundingClientRect = () => new DOMRect(0, 100 * line, 10, 20);
      block.scrollIntoView = (options) => {
        scrolled.push(`${line} ${JSON.stringify(options)}`);
      };
      root.append(block);
    }
    const { annotationsDoc, panelParent, cards, panel } = setUp(
      false,
      undefined,
      root,
    );
    // The annotation on « three », line 2: closed.
    const id =
      cards().find((item) => item.textContent?.includes("three"))?.dataset.id ??
      "";
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    panelParent
      .querySelector<HTMLButtonElement>('[data-filter="closed"]')
      ?.click();

    panelParent.querySelector<HTMLButtonElement>(".see-text")?.click();
    await new Promise((done) => requestAnimationFrame(() => done(undefined)));

    const card = cards().find((item) => item.dataset.id === id);
    expect(card?.parentElement?.classList.contains("open-list")).toBe(true);
    expect(card?.style.top).toBe("200px");
    expect(scrolled).toEqual([`2 ${JSON.stringify({ block: "center" })}`]);
    expect(panel.active.id).toBe(id);
  });
});
