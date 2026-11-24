// @vitest-environment jsdom
// The hints at the moment of surprise (phase 37h, ADR-0064, AC4 – AC7):
// the markup shown again on the caret's line, a diagram drawn only in
// Reading; each once, by a move of the caret, closed by its button,
// Escape, or the caret leaving.
import { forceParsing } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import { createDocumentEditor } from "./editor.js";
import { type Hint, firstHints } from "./first-hints.js";
import { withoutLayout } from "./test-support/no-layout.js";

const TEXT = [
  "Plain words here.", // 1
  "# A heading", // 2
  "Some **bold** text.", // 3
  "```mermaid", // 4
  "flowchart LR", // 5
  "  A --> B", // 6
  "```", // 7
  "Last line.", // 8
].join("\n");

const parents: Element[] = [];
const destroyedAfter = withoutLayout();
beforeEach(() => resetCounters());
afterEach(() => {
  for (const parent of parents.splice(0)) parent.remove();
});

function setUp(
  options: { seen?: Hint[]; livePreview?: boolean; readOnly?: boolean } = {},
) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, TEXT);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  parents.push(parent);
  const editor = createDocumentEditor(parent, doc, {
    livePreview: options.livePreview ?? true,
    readOnly: options.readOnly ?? false,
  });
  const { view } = editor;
  destroyedAfter(view);
  forceParsing(view, view.state.doc.length, 5000);
  const remembered: Hint[] = [];
  const toReading = vi.fn();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      firstHints({
        seen: new Set(options.seen ?? []),
        remember: (hint) => remembered.push(hint),
        toReading,
      }),
    ),
  });
  const lineStart = (n: number) => view.state.doc.line(n).from;
  const moveTo = (pos: number, userEvent = "select") =>
    view.dispatch({ selection: { anchor: pos }, userEvent });
  const hint = () => parent.querySelector<HTMLElement>(".first-hint");
  const button = (label: string) =>
    Array.from(
      parent.querySelectorAll<HTMLButtonElement>(".first-hint button"),
    ).find((b) => b.textContent?.trim() === label);
  return {
    editor,
    view,
    lineStart,
    moveTo,
    hint,
    button,
    remembered,
    toReading,
  };
}

describe("the markup's hint (AC4)", () => {
  test("on a line whose markup is hidden elsewhere, once, remembered as shown", () => {
    const s = setUp();
    s.moveTo(s.lineStart(1));
    expect(s.hint()).toBeNull();
    s.moveTo(s.lineStart(3) + 2);
    expect(s.hint()?.textContent).toContain("markup shows where you write");
    expect(s.remembered).toEqual(["markup"]);

    s.button("Got it")?.click();
    expect(s.hint()).toBeNull();
    s.moveTo(s.lineStart(2));
    expect(s.hint()).toBeNull();
    expect(s.remembered).toEqual(["markup"]);
  });

  test("closed by the caret leaving its line, and by Escape", () => {
    const s = setUp();
    s.moveTo(s.lineStart(2) + 3);
    expect(s.hint()).not.toBeNull();
    s.moveTo(s.lineStart(2) + 5);
    expect(s.hint()).not.toBeNull();
    s.moveTo(s.lineStart(1));
    expect(s.hint()).toBeNull();

    const t = setUp();
    t.moveTo(t.lineStart(3));
    t.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(t.hint()).toBeNull();
  });

  test("never by typing, nor in the source, nor read only, nor seen before", () => {
    const typed = setUp();
    typed.moveTo(typed.lineStart(3), "input.type");
    expect(typed.hint()).toBeNull();
    for (const s of [
      setUp({ livePreview: false }),
      setUp({ readOnly: true }),
      setUp({ seen: ["markup"] }),
    ]) {
      s.moveTo(s.lineStart(3));
      expect(s.hint()).toBeNull();
    }
  });
});

describe("the diagram's hint (AC5)", () => {
  test("the caret in a diagram: drawn in Reading, its button goes there", () => {
    const s = setUp({ seen: ["markup"] });
    s.moveTo(s.lineStart(5) + 2);
    expect(s.hint()?.textContent).toContain("drawn in Reading");
    expect(s.remembered).toEqual(["diagram"]);
    s.button("Reading")?.click();
    expect(s.toReading).toHaveBeenCalledTimes(1);
    expect(s.hint()).toBeNull();
  });

  test("in the source too; closed when the caret leaves the block", () => {
    const s = setUp({ seen: ["markup"], livePreview: false });
    s.moveTo(s.lineStart(4));
    expect(s.hint()).not.toBeNull();
    s.moveTo(s.lineStart(7));
    expect(s.hint()).not.toBeNull();
    s.moveTo(s.lineStart(8));
    expect(s.hint()).toBeNull();
  });

  test("one hint at a time: the markup's shown, the diagram's waits", () => {
    const s = setUp();
    s.moveTo(s.lineStart(3));
    expect(s.hint()?.textContent).toContain("markup");
    // Not closed by moving into the diagram: it closes, and the other
    // waits for the next move.
    s.moveTo(s.lineStart(5));
    expect(s.hint()).toBeNull();
    s.moveTo(s.lineStart(6));
    expect(s.hint()?.textContent).toContain("drawn in Reading");
    expect(s.remembered).toEqual(["markup", "diagram"]);
  });
});

describe("its installation", () => {
  // Seen in Chromium (check.mjs): CodeMirror logs what a listener throws.
  test("added to an open editor without an error", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = setUp();
      s.moveTo(s.lineStart(3));
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe("its cost (AC7)", () => {
  test("nothing for a keystroke; nothing for a move once both are seen", () => {
    const s = setUp();
    resetCounters();
    s.view.dispatch({
      changes: { from: s.lineStart(1), insert: "x" },
      selection: { anchor: s.lineStart(1) + 1 },
      userEvent: "input.type",
    });
    expect(counter("hints.check")).toBe(0);

    const seen = setUp({ seen: ["markup", "diagram"] });
    resetCounters();
    seen.moveTo(seen.lineStart(3));
    seen.moveTo(seen.lineStart(5));
    expect(counter("hints.check")).toBe(0);
  });
});
