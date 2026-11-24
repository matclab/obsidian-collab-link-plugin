// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AnnotationIndex,
  createAnnotation,
} from "../../../lib/src/annotations/index.js";
import type { Role } from "../../../lib/src/crypto/index.js";
import {
  type EditorFactory,
  createDocumentEditor,
} from "../../editor/editor.js";
import { obsidianLike } from "../../editor/test-support/obsidian-like.js";
import { counter, resetCounters } from "../../perf/index.js";
import { RENDER_DELAY_MS } from "./preview.js";
import { createViewSwitch } from "./view-switch.js";

function setUp(
  role: Role,
  text = "# Title\n\nsome text",
  modesParent?: Element,
  livePreview = false,
  wideAtFirst = false,
  provide?: EditorFactory,
) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const parent = document.createElement("div");
  const editor = createDocumentEditor(parent, contentDoc, {
    livePreview,
    ...(provide && { provide }),
  });
  const index = new AnnotationIndex(contentDoc, annotationsDoc);
  let wide = wideAtFirst;
  const screenListeners: (() => void)[] = [];
  const views = createViewSwitch(
    parent,
    editor,
    index,
    role,
    { author: () => "me", confirm: () => true, preferences: localStorage },
    {},
    modesParent,
    {
      matches: () => wide,
      onChange: (listener) => screenListeners.push(listener),
    },
  );
  const button = (label: string) =>
    [parent, ...(modesParent ? [modesParent] : [])]
      .flatMap((root) => Array.from(root.querySelectorAll("button")))
      .find((element) => element.textContent?.trim() === label);
  const previewShown = () => parent.querySelector<HTMLElement>(".preview");
  return {
    contentDoc,
    annotationsDoc,
    parent,
    editor,
    views,
    button,
    previewShown,
    wideNow(next: boolean) {
      wide = next;
      for (const listener of screenListeners) listener();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCounters();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("createViewSwitch", () => {
  test("a read link opens on the preview", () => {
    const { parent, editor, previewShown } = setUp("read");

    expect(previewShown()?.hidden).toBe(false);
    expect(parent.querySelector(".preview h1")?.textContent).toBe("Title");
    expect(editor.view.dom.hidden).toBe(true);
  });

  test("the other links open on the source, with nothing rendered", () => {
    for (const role of ["edit", "suggest"] as const) {
      const { editor, previewShown } = setUp(role);
      expect(previewShown()?.hidden).toBe(true);
      expect(editor.view.dom.hidden).toBe(false);
    }
    expect(counter("preview.render")).toBe(0);
  });

  // ADR-0064, AC8: one control, three views, one at a time.
  test("in Write, Formatted, Source or Reading: one pressed at a time", () => {
    const { editor, button, previewShown } = setUp(
      "edit",
      "# Title",
      undefined,
      true,
    );
    const pressed = () =>
      ["Formatted", "Source", "Reading"].filter(
        (label) => button(label)?.getAttribute("aria-pressed") === "true",
      );
    expect(button("Write")?.getAttribute("aria-pressed")).toBe("true");
    expect(pressed()).toEqual(["Formatted"]);

    button("Reading")?.click();
    expect(previewShown()?.hidden).toBe(false);
    expect(editor.view.dom.hidden).toBe(true);
    expect(pressed()).toEqual(["Reading"]);
    expect(button("Write")?.getAttribute("aria-pressed")).toBe("true");
    // Pressed again, it stays: a choice, not a toggle.
    button("Reading")?.click();
    expect(pressed()).toEqual(["Reading"]);

    button("Source")?.click();
    expect(previewShown()?.hidden).toBe(true);
    expect(editor.view.dom.hidden).toBe(false);
    expect(editor.formatting()).toBe(false);
    expect(pressed()).toEqual(["Source"]);

    button("Formatted")?.click();
    expect(editor.formatting()).toBe(true);
    expect(pressed()).toEqual(["Formatted"]);
  });

  // Phase 37d: the formatted editor looks like it; it says what it is.
  test("Reading says what it shows, and that nothing is edited there", () => {
    const { parent, button } = setUp("edit");
    const readOnly = () => parent.querySelector(".read-only-note");
    expect(button("Reading")?.title).toBe(
      "The document as its readers see it: diagrams and formulas drawn, nothing to edit.",
    );
    expect(readOnly()).toBeNull();

    button("Reading")?.click();
    expect(readOnly()?.textContent?.trim()).toBe("Read only");

    button("Formatted")?.click();
    expect(readOnly()).toBeNull();
  });

  // ADR-0064, AC5: the diagram's hint leads there.
  test("asked to show Reading: shown, its toggle pressed; asked again, it stays", () => {
    const { views, editor, button, previewShown } = setUp("edit");
    views.showReading();
    expect(previewShown()?.hidden).toBe(false);
    expect(editor.view.dom.hidden).toBe(true);
    expect(button("Reading")?.getAttribute("aria-pressed")).toBe("true");
    views.showReading();
    expect(previewShown()?.hidden).toBe(false);
  });

  test("not for a read link, whose header already says it reads only", () => {
    const { parent, previewShown } = setUp("read");
    expect(previewShown()?.hidden).toBe(false);
    expect(parent.querySelector(".read-only-note")).toBeNull();
  });

  test("Source or Formatted kept in this browser; Reading not (AC8)", () => {
    const { editor, button } = setUp("edit", "# Title", undefined, true);
    button("Source")?.click();
    expect(localStorage.getItem("obsidian-collab:editor")).toBe("source");
    button("Reading")?.click();
    expect(localStorage.getItem("obsidian-collab:editor")).toBe("source");
    button("Formatted")?.click();
    expect(editor.formatting()).toBe(true);
    expect(localStorage.getItem("obsidian-collab:editor")).toBeNull();
  });

  test("the modes go where they are given, the view choice right after them on a wide view, Reading's note over the text", () => {
    const modes = document.createElement("div");
    const { parent, button } = setUp("edit", "# Title", modes, false, true);
    expect(modes.contains(button("Write") ?? null)).toBe(true);
    expect(modes.contains(button("History") ?? null)).toBe(true);
    // A place of its own, whatever the bar over the text holds: no
    // button moves as the view changes.
    const choice = button("Reading")?.closest(".view-switch");
    expect(choice?.previousElementSibling?.classList.contains("modes")).toBe(
      true,
    );
    expect(modes.contains(button("Side by side") ?? null)).toBe(true);

    button("Reading")?.click();
    expect(parent.querySelector(".read-only-note")).not.toBeNull();
    expect(modes.querySelector(".read-only-note")).toBeNull();
  });

  test("on a view not wide, the view choice first over the text; with the modes again once it widens", () => {
    const modes = document.createElement("div");
    const { parent, editor, button, wideNow } = setUp("edit", "# Title", modes);
    const bar = parent.querySelector(".column-tools");
    // The header has no room left for it.
    expect(bar?.firstElementChild?.contains(button("Source") ?? null)).toBe(
      true,
    );

    wideNow(true);
    expect(
      button("Source")
        ?.closest(".view-switch")
        ?.previousElementSibling?.classList.contains("modes"),
    ).toBe(true);
    button("Source")?.click();
    expect(editor.formatting()).toBe(false);

    wideNow(false);
    expect(bar?.contains(button("Formatted") ?? null)).toBe(true);
    expect(modes.querySelector(".view-switch")).toBeNull();
  });

  test("the history takes the editor's place, for every role (phase 7b)", () => {
    for (const role of ["edit", "suggest", "read"] as const) {
      const { parent, editor, button, previewShown } = setUp(role);
      const historyShown = () => parent.querySelector<HTMLElement>(".history");

      button("History")?.click();
      expect(historyShown()?.hidden).toBe(false);
      expect(editor.view.dom.hidden).toBe(true);
      expect(previewShown()?.hidden).toBe(true);
      expect(parent.querySelectorAll(".history-entry")).toHaveLength(1);

      expect(button("Reading")?.closest("[hidden]")).not.toBeNull();

      button("Write")?.click();
      expect(historyShown()?.hidden).toBe(true);
      // Back to Write as it was: a read link, on the preview.
      expect(editor.view.dom.hidden).toBe(role === "read");
      expect(previewShown()?.hidden).toBe(role !== "read");
    }
  });

  test("the preview says how many suggestions are pending, not counting comments", async () => {
    const { contentDoc, annotationsDoc, parent } = setUp("read");
    const banner = () => parent.querySelector(".pending-suggestions");
    expect(banner()).toBeNull();

    for (const type of ["deletion", "comment", "deletion"] as const) {
      createAnnotation(contentDoc, annotationsDoc, {
        type,
        start: 0,
        end: 1,
        author: "alice",
        ...(type === "comment" && { body: "hm" }),
      });
    }
    annotationsDoc.commit();
    await vi.advanceTimersByTimeAsync(0);

    expect(banner()?.textContent?.trim()).toBe(
      "2 pending suggestions, shown by marks: the text is the current one.",
    );
  });
});

// Phase 11, decision 11, as ADR-0064 AC9 has it: on a wide screen, in
// Source, the source on the left, the whole rendering on the right.
describe("side by side", () => {
  const SIDE_KEY = "obsidian-collab:side-by-side";

  test("on a wide screen, in Source, the source and its rendering together, kept in this browser", () => {
    const { parent, editor, button, previewShown, views } = setUp(
      "edit",
      "# Title",
      undefined,
      true,
      true,
    );
    // An option of Source's (AC9); its place kept elsewhere, where the
    // screen is wide: choosing Source moves nothing.
    expect(button("Side by side")?.hidden).toBe(false);
    expect(button("Side by side")?.inert).toBe(true);
    button("Source")?.click();
    expect(button("Side by side")?.hidden).toBe(false);
    expect(button("Side by side")?.inert).toBe(false);
    expect(button("Side by side")?.getAttribute("aria-pressed")).toBe("false");

    button("Side by side")?.click();
    expect(editor.view.dom.hidden).toBe(false);
    expect(previewShown()?.hidden).toBe(false);
    expect(parent.querySelector(".preview h1")?.textContent).toBe("Title");
    expect(parent.classList.contains("side-by-side")).toBe(true);
    expect(views.sideBySide()).toBe(true);
    expect(button("Side by side")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Source")?.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(SIDE_KEY)).toBe("on");

    // Formatted: the editor alone, the choice kept for Source.
    button("Formatted")?.click();
    expect(views.sideBySide()).toBe(false);
    expect(previewShown()?.hidden).toBe(true);
    expect(button("Side by side")?.inert).toBe(true);
    expect(localStorage.getItem(SIDE_KEY)).toBe("on");
    button("Source")?.click();
    expect(views.sideBySide()).toBe(true);

    button("Side by side")?.click();
    expect(previewShown()?.hidden).toBe(true);
    expect(parent.classList.contains("side-by-side")).toBe(false);
    expect(views.sideBySide()).toBe(false);
    expect(localStorage.getItem(SIDE_KEY)).toBeNull();
  });

  test("the choice kept opens the next document side by side, in Source only", () => {
    localStorage.setItem(SIDE_KEY, "on");
    const { editor, previewShown, views } = setUp(
      "edit",
      "# Title",
      undefined,
      false,
      true,
    );
    expect(views.sideBySide()).toBe(true);
    expect(editor.view.dom.hidden).toBe(false);
    expect(previewShown()?.hidden).toBe(false);

    const formatted = setUp("edit", "# Title", undefined, true, true);
    expect(formatted.views.sideBySide()).toBe(false);
    expect(formatted.previewShown()?.hidden).toBe(true);
  });

  test("on a narrow screen, no side by side: the editor alone, until the screen is wide", () => {
    localStorage.setItem(SIDE_KEY, "on");
    const { parent, editor, button, previewShown, views, wideNow } =
      setUp("edit");
    expect(button("Side by side")?.hidden).toBe(true);
    expect(views.sideBySide()).toBe(false);
    expect(previewShown()?.hidden).toBe(true);
    expect(editor.view.dom.hidden).toBe(false);

    const told: string[] = [];
    views.onMode((mode) => told.push(mode));
    wideNow(true);
    expect(views.sideBySide()).toBe(true);
    expect(previewShown()?.hidden).toBe(false);
    expect(told).toEqual(["write"]);

    wideNow(false);
    expect(views.sideBySide()).toBe(false);
    expect(parent.classList.contains("side-by-side")).toBe(false);
    expect(previewShown()?.hidden).toBe(true);
    expect(localStorage.getItem(SIDE_KEY)).toBe("on");
  });

  test("Reading and side by side, one or the other; back to Source, side by side again", () => {
    const { editor, button, previewShown, views } = setUp(
      "edit",
      "# Title",
      undefined,
      false,
      true,
    );
    button("Side by side")?.click();
    button("Reading")?.click();
    expect(views.sideBySide()).toBe(false);
    expect(editor.view.dom.hidden).toBe(true);
    expect(button("Side by side")?.inert).toBe(true);
    expect(localStorage.getItem(SIDE_KEY)).toBe("on");

    button("Source")?.click();
    expect(views.sideBySide()).toBe(true);
    expect(editor.view.dom.hidden).toBe(false);
    expect(previewShown()?.hidden).toBe(false);
    expect(button("Reading")?.getAttribute("aria-pressed")).toBe("false");
  });

  test("a read link opens on Reading, side by side kept or not (AC8); Source, then side by side", () => {
    localStorage.setItem(SIDE_KEY, "on");
    const { editor, button, previewShown, views } = setUp(
      "read",
      "# Title",
      undefined,
      false,
      true,
    );
    expect(editor.view.dom.hidden).toBe(true);
    expect(previewShown()?.hidden).toBe(false);
    expect(views.sideBySide()).toBe(false);

    button("Source")?.click();
    expect(views.sideBySide()).toBe(true);
    expect(editor.view.dom.hidden).toBe(false);
    expect(localStorage.getItem(SIDE_KEY)).toBe("on");
  });

  test("the rendering follows the typing, after the preview's delay", () => {
    const { parent, editor, button } = setUp(
      "edit",
      "# Title",
      undefined,
      false,
      true,
    );
    button("Side by side")?.click();
    editor.view.dispatch({
      changes: { from: 7, insert: " two" },
      userEvent: "input.type",
    });
    vi.advanceTimersByTime(RENDER_DELAY_MS - 1);
    expect(parent.querySelector(".preview h1")?.textContent).toBe("Title");
    vi.advanceTimersByTime(1);
    expect(parent.querySelector(".preview h1")?.textContent).toBe("Title two");
  });

  test("Review and History are never side by side; back in Write, it is again", () => {
    const { parent, editor, button, previewShown, views } = setUp(
      "edit",
      "# Title",
      undefined,
      false,
      true,
    );
    button("Side by side")?.click();
    for (const mode of ["Review", "History"]) {
      button(mode)?.click();
      expect(views.sideBySide()).toBe(false);
      expect(parent.classList.contains("side-by-side")).toBe(false);
      expect(previewShown()?.hidden).toBe(true);
    }
    button("Review")?.click();
    expect(editor.view.dom.hidden).toBe(false);
    button("Write")?.click();
    expect(views.sideBySide()).toBe(true);
    expect(previewShown()?.hidden).toBe(false);
  });
});

// Phase 17, decision 4: a host's editor has its own formatting and
// preview (Obsidian's); the view offers neither its Source, its Preview
// nor its side by side, and a read link opens on the editor, read only.
describe("with an editor a host provides", () => {
  test("no Formatted, Source, Reading or Side by side over the text, wide or not", () => {
    for (const role of ["edit", "suggest", "read"] as const) {
      const { button, wideNow } = setUp(
        role,
        undefined,
        undefined,
        false,
        true,
        obsidianLike,
      );
      wideNow(true);
      expect(button("Formatted")).toBeUndefined();
      expect(button("Source")).toBeUndefined();
      expect(button("Reading")).toBeUndefined();
      expect(button("Side by side")).toBeUndefined();
    }
  });

  test("a read link opens on the editor", () => {
    const { editor, previewShown } = setUp(
      "read",
      undefined,
      undefined,
      false,
      false,
      obsidianLike,
    );
    expect(editor.view.dom.hidden).toBe(false);
    expect(previewShown()?.hidden ?? true).toBe(true);
  });

  test("its modes still are: Review and History, then Write again", () => {
    const { editor, button } = setUp(
      "edit",
      undefined,
      undefined,
      false,
      false,
      obsidianLike,
    );
    button("History")?.click();
    expect(editor.view.dom.hidden).toBe(true);
    button("Write")?.click();
    expect(editor.view.dom.hidden).toBe(false);
  });

  // Obsidian's editor's own element stayed, as high as the editor, over
  // the history: the versions far below an empty screen (2026-10-16).
  test("in History, its own element goes too, not only CodeMirror's", () => {
    const { parent, button } = setUp(
      "edit",
      undefined,
      undefined,
      false,
      false,
      obsidianLike,
    );
    const own = parent.querySelector<HTMLElement>(".markdown-source-view");
    button("History")?.click();
    expect(own?.hidden).toBe(true);
    button("Write")?.click();
    expect(own?.hidden).toBe(false);
  });
});
