// @vitest-environment jsdom
// "Who wrote" in the view (ADR-0059 §4): a switch among the toggles, off
// at opening; on, a legend over the text, the person at the caret brought
// forward with its date; hidden in History.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import { registerPeers } from "../../../lib/src/history/tables.js";
import { authorMarks } from "../../editor/authorship.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { formatShortDate } from "../../i18n/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import type { Mode } from "../reading/view-switch.js";
import { attachAuthorshipView } from "./authorship-view.js";

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

function setUp(narrowView = false) {
  const bob = new LoroDoc();
  bob.setPeerId(2n);
  bob.setRecordTimestamp(true);
  bob.setNextCommitTimestamp(1_700_000_000);
  bob.getText("content").insert(0, "hello world");
  bob.commit();
  const contentDoc = new LoroDoc();
  contentDoc.setPeerId(1n);
  sync(bob, contentDoc);
  const annotationsDoc = new LoroDoc();
  registerPeers(annotationsDoc, ["2"], "bob");
  registerPeers(annotationsDoc, ["1"], "alice");
  const parent = document.createElement("div");
  const bar = document.createElement("div");
  parent.append(bar);
  document.body.append(parent);
  const editor = createDocumentEditor(parent, contentDoc);
  let mode: Mode = "write";
  const listeners: ((mode: Mode) => void)[] = [];
  const queue: (() => void)[] = [];
  const schedule = (run: () => void) => queue.push(run);
  const shown = attachAuthorshipView({
    editor,
    contentDoc,
    annotationsDoc,
    parent,
    views: {
      bar,
      mode: () => mode,
      onMode: (listener) => listeners.push(listener),
    },
    narrow: { matches: () => narrowView, onChange: () => {} },
    schedule,
  });
  const flush = () => {
    while (queue.length > 0) for (const run of queue.splice(0)) run();
  };
  const legend = () => parent.querySelector<HTMLElement>(".authorship-legend");
  const setMode = (next: Mode) => {
    mode = next;
    for (const listener of listeners) listener(next);
  };
  return { editor, shown, flush, legend, parent, setMode, contentDoc };
}

describe("who wrote, in the view", () => {
  test("off at opening: the switch unpressed, no legend", () => {
    const { shown, legend, parent } = setUp();
    expect(shown.toggle.getAttribute("aria-pressed")).toBe("false");
    expect(legend()?.hidden).toBe(true);
    expect(parent.classList.contains("authorship-on")).toBe(false);
  });

  test("on: the persons shown, and who wrote at the caret, with the date", () => {
    const { shown, legend, flush, editor, parent } = setUp();
    editor.view.dispatch({ changes: { from: 0, insert: "Oh, " } });
    editor.view.dispatch({ selection: { anchor: 8 } });
    shown.toggle.click();
    flush();
    expect(shown.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(parent.classList.contains("authorship-on")).toBe(true);
    const box = legend() as HTMLElement;
    expect(box.hidden).toBe(false);
    const persons = Array.from(box.querySelectorAll("li"), (li) =>
      li.textContent?.trim(),
    );
    // bob wrote first: his color first.
    expect(persons).toEqual(["bob", "alice"]);
    expect(box.querySelector(".designated")?.textContent).toContain("bob");
    expect(box.textContent).toContain(formatShortDate(1_700_000_000_000));
    expect(authorMarks(editor.view.state).length).toBeGreaterThan(0);
  });

  test("the caret in my text brings me forward", () => {
    const { shown, legend, flush, editor } = setUp();
    editor.view.dispatch({ changes: { from: 0, insert: "Oh, " } });
    shown.toggle.click();
    flush();
    editor.view.dispatch({ selection: { anchor: 2 } });
    flush();
    expect(legend()?.querySelector("li.designated")?.textContent).toContain(
      "alice",
    );
  });

  test("off again: no legend, no tint, nothing rendered", () => {
    const { shown, legend, flush, editor, parent } = setUp();
    shown.toggle.click();
    flush();
    shown.toggle.click();
    expect(legend()?.hidden).toBe(true);
    expect(parent.classList.contains("authorship-on")).toBe(false);
    resetCounters();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    flush();
    expect(counter("authorship.legend")).toBe(0);
    expect(authorMarks(editor.view.state)).toEqual([]);
  });

  test("hidden in History, back in Write", () => {
    const { shown, legend, flush, setMode } = setUp();
    shown.toggle.click();
    flush();
    setMode("history");
    expect(shown.toggle.hidden).toBe(true);
    expect(legend()?.hidden).toBe(true);
    setMode("write");
    expect(shown.toggle.hidden).toBe(false);
    expect(legend()?.hidden).toBe(false);
  });

  test("narrow: the person at the caret alone, the list unfolded on demand", () => {
    const { shown, legend, flush, editor } = setUp(true);
    editor.view.dispatch({ selection: { anchor: 3 } });
    shown.toggle.click();
    flush();
    const box = legend() as HTMLElement;
    expect(box.querySelector("li")).toBeNull();
    expect(box.querySelector(".designated")?.textContent).toContain("bob");
    const unfold = box.querySelector<HTMLButtonElement>(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    unfold.click();
    flushSync();
    expect(box.querySelectorAll("li")).toHaveLength(1);
  });

  test("one rendering per batch of updates, one date read", () => {
    const { shown, flush, editor } = setUp();
    shown.toggle.click();
    flush();
    resetCounters();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    editor.view.dispatch({ changes: { from: 1, insert: "b" } });
    flush();
    expect(counter("authorship.legend")).toBe(1);
    expect(counter("authorship.date")).toBe(1);
    expect(counter("authorship.char")).toBe(0);
  });

  describe("in the preview (ADR-0059 §6)", () => {
    /** The editor hidden, a preview of two blocks: lines 0 and 2. */
    function withPreview() {
      const bob = new LoroDoc();
      bob.setPeerId(2n);
      bob.getText("content").insert(0, "hello world\n\nsecond");
      bob.commit();
      const contentDoc = new LoroDoc();
      contentDoc.setPeerId(1n);
      sync(bob, contentDoc);
      const annotationsDoc = new LoroDoc();
      registerPeers(annotationsDoc, ["2"], "bob");
      registerPeers(annotationsDoc, ["1"], "alice");
      const parent = document.createElement("div");
      const bar = document.createElement("div");
      parent.append(bar);
      document.body.append(parent);
      const editor = createDocumentEditor(parent, contentDoc);
      // Alice's « wide » in the first block, before its rendering.
      editor.view.dispatch({ changes: { from: 6, insert: "wide " } });
      editor.view.dom.hidden = true;
      const root = document.createElement("div");
      parent.append(root);
      const rendered: (() => void)[] = [];
      const block = (line: number, end: number, text: string) => {
        const p = document.createElement("p");
        p.dataset.line = String(line);
        p.dataset.lineEnd = String(end);
        p.textContent = text;
        root.append(p);
        return p;
      };
      const first = block(0, 1, "hello wide world");
      const second = block(2, 3, "second");
      const queue: (() => void)[] = [];
      const schedule = (run: () => void) => queue.push(run);
      const shown = attachAuthorshipView({
        editor,
        contentDoc,
        annotationsDoc,
        parent,
        views: {
          bar,
          mode: () => "write",
          onMode: () => {},
          preview: {
            visible: true,
            root,
            onRendered: (listener) => rendered.push(listener),
          },
        },
        schedule,
      });
      const flush = () => {
        while (queue.length > 0) for (const run of queue.splice(0)) run();
      };
      return { shown, flush, first, second, root, parent, editor, rendered };
    }

    test("a bar per block, a segment per person, by share", () => {
      const { shown, flush, first, second, root } = withPreview();
      shown.toggle.click();
      flush();
      expect(root.classList.contains("authorship-on")).toBe(true);
      // « hello wide world »: bob 11 characters, alice 5.
      expect(first.dataset.authors).toBe(
        "linear-gradient(var(--author-1-line) 0.00% 68.75%, var(--author-2-line) 68.75% 100.00%)",
      );
      expect(first.style.getPropertyValue("--authors")).toBe(
        first.dataset.authors,
      );
      expect(second.dataset.authors).toBe(
        "linear-gradient(var(--author-1-line) 0.00% 100.00%)",
      );
    });

    test("the whole text read once, then nothing for a keystroke", () => {
      const { shown, flush, editor } = withPreview();
      resetCounters();
      shown.toggle.click();
      flush();
      expect(counter("authorship.char")).toBe(editor.view.state.doc.length);
      resetCounters();
      editor.view.dispatch({ changes: { from: 0, insert: "a" } });
      flush();
      expect(counter("authorship.char")).toBe(0);
      expect(counter("authorship.bars")).toBe(0);
    });

    test("a block pointed at: its persons brought forward", () => {
      const { shown, flush, first, parent } = withPreview();
      shown.toggle.click();
      flush();
      first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      flush();
      const legend = parent.querySelector(".authorship-legend") as HTMLElement;
      expect(
        Array.from(legend.querySelectorAll("li.designated"), (li) =>
          li.textContent?.trim(),
        ),
      ).toEqual(["bob", "alice"]);
      expect(legend.querySelector(".said")?.textContent).toBe("bob, alice");
    });

    test("a rendering draws the bars again", () => {
      const { shown, flush, root, rendered } = withPreview();
      shown.toggle.click();
      flush();
      const third = document.createElement("p");
      third.dataset.line = "2";
      third.dataset.lineEnd = "3";
      root.replaceChildren(third);
      resetCounters();
      for (const listener of rendered) listener();
      flush();
      expect(counter("authorship.bars")).toBe(1);
      expect(third.dataset.authors).toContain("--author-1-line");
    });
  });
});
