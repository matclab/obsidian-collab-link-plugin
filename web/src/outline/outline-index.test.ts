import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import { OutlineIndex } from "./outline-index.js";
import { outlineOfText } from "./outline.js";

const docOf = (text: string) => Text.of(text.split("\n"));

/** An index on `text`, and a way to edit it as the editor would. */
function indexed(text: string) {
  let doc = docOf(text);
  const index = new OutlineIndex(doc);
  const edit = (from: number, to: number, insert: string) => {
    const changes = ChangeSet.of({ from, to, insert }, doc.length);
    doc = changes.apply(doc);
    index.update(changes, doc);
  };
  return { index, edit, text: () => doc.toString() };
}

const microtask = () => new Promise<void>((done) => queueMicrotask(done));

describe("OutlineIndex", () => {
  test("follows the text: a heading typed, renamed, taken away", () => {
    const { index, edit, text } = indexed("# One\n\npara\n");
    expect(index.current().map((h) => h.text)).toEqual(["One"]);
    edit(text().length, text().length, "\n## Two");
    expect(index.current()).toEqual(outlineOfText(text()));
    edit(0, 5, "# Uno");
    expect(index.current().map((h) => h.text)).toEqual(["Uno", "Two"]);
    edit(0, 1, "");
    expect(index.current()).toEqual(outlineOfText(text()));
  });

  test("a fence opened above takes the headings below; closed, gives them back", () => {
    const { index, edit, text } = indexed("# A\n\npara\n\n## B\n\n## C");
    edit(text().indexOf("para"), text().indexOf("para"), "```\n");
    expect(index.current().map((h) => h.text)).toEqual(["A"]);
    edit(text().length, text().length, "\n```\n## D");
    expect(index.current()).toEqual(outlineOfText(text()));
  });

  test("a paragraph underlined becomes a heading", () => {
    const { index, edit, text } = indexed("# A\n\nUnder\n\n## B");
    const at = text().indexOf("\n\n## B");
    edit(at, at, "\n===");
    expect(index.current().map((h) => h.text)).toEqual(["A", "Under", "B"]);
  });

  test("an underline made a list: the heading above it is undone", () => {
    // The change is inside the list's line: the block it starts in is the
    // list, and the paragraph above it changed too.
    const { index, edit, text } = indexed("# A\n\nUnder\n---\n\n## B");
    const at = text().indexOf("---") + 1;
    edit(at, at, " ");
    expect(index.current().map((h) => h.text)).toEqual(["A", "B"]);
    expect(index.current()).toEqual(outlineOfText(text()));
  });

  // Found by the property (2026-10-20, « Défauts connus »): the block the
  // old list resumes at is after the change, not on another line; a space
  // taken from its indent moves everything below by one, its line's start
  // by none.
  test("an edit before a block, on its own line: the headings below follow it", () => {
    const { index, edit, text } = indexed("  a\n# A\n\n## B");
    expect(index.current()).toEqual(outlineOfText(text()));
    edit(0, 1, "");
    expect(index.current()).toEqual(outlineOfText(text()));
    edit(0, 0, "  ");
    expect(index.current()).toEqual(outlineOfText(text()));
  });

  test("positions and lines below an edit follow it", () => {
    const { index, edit, text } = indexed("# A\n\npara\n\n## B\n\n### C");
    edit(5, 5, "more\nlines\n");
    expect(index.current()).toEqual(outlineOfText(text()));
  });

  test("parses nothing until read, when nobody listens", () => {
    const { index, edit } = indexed("# A\n\npara");
    resetCounters();
    edit(5, 5, "x");
    edit(6, 6, "y");
    expect(counter("outline.parse")).toBe(0);
    index.current();
    expect(counter("outline.parse")).toBe(1);
  });

  test("a listener is told once per microtask, and only when the list shown changes", async () => {
    const { index, edit, text } = indexed("# A\n\npara");
    let told = 0;
    index.subscribe(() => told++);
    edit(text().length, text().length, " more");
    await microtask();
    expect(told).toBe(0);
    edit(2, 2, "B");
    edit(text().length, text().length, "\n\n## C");
    await microtask();
    expect(told).toBe(1);
    expect(index.current().map((h) => h.text)).toEqual(["BA", "C"]);
  });

  test("a listener is told of a change someone read before the notification", async () => {
    const { index, edit, text } = indexed("# A\n\npara");
    let told = 0;
    index.subscribe(() => told++);
    edit(text().length, text().length, "\n\n## B");
    // Read first (a heading chosen), then the notification.
    expect(index.current().map((h) => h.text)).toEqual(["A", "B"]);
    await microtask();
    expect(told).toBe(1);
  });

  test("nobody listening any more when the notification runs: nothing parsed", async () => {
    const { index, edit, text } = indexed("# A\n\npara");
    const stop = index.subscribe(() => {});
    edit(text().length, text().length, " more");
    stop();
    resetCounters();
    await microtask();
    expect(counter("outline.parse")).toBe(0);
  });

  test("an unsubscribed listener is told nothing", async () => {
    const { index, edit } = indexed("# A");
    let told = 0;
    const stop = index.subscribe(() => told++);
    stop();
    edit(1, 1, "B");
    await microtask();
    expect(told).toBe(0);
  });
});

describe("OutlineIndex (budgets)", () => {
  /** A document of `sections` sections: a heading, paragraphs, a list. */
  const long = (sections: number) =>
    Array.from(
      { length: sections },
      (_, i) => `## Section ${i}\n\nSome text.\n\nMore text.\n\n- a\n- b`,
    ).join("\n\n");

  /** The blocks looked at for a keystroke in the middle of a paragraph,
   * the outline read after it, as a listener would. */
  function keystroke(sections: number): { blocks: number; parses: number } {
    const { index, edit, text } = indexed(long(sections));
    const at = text().indexOf("Some text.", text().length / 2) + 4;
    resetCounters();
    edit(at, at, "k");
    index.current();
    return {
      blocks: counter("outline.block"),
      parses: counter("outline.parse"),
    };
  }

  test("a keystroke in a paragraph: one parse, a few blocks, whatever the length", () => {
    const small = keystroke(50);
    const large = keystroke(200);
    expect(small.parses).toBe(1);
    expect(large.parses).toBe(1);
    expect(small.blocks).toBeLessThanOrEqual(4);
    expect(large.blocks).toBe(small.blocks);
  });

  test("a keystroke in a paragraph tells no listener", async () => {
    const { index, edit, text } = indexed(long(20));
    let told = 0;
    index.subscribe(() => told++);
    const at = text().indexOf("Some text.") + 4;
    edit(at, at, "k");
    await microtask();
    expect(told).toBe(0);
  });
});

// Reported by the user (2026-10-17): the page's outline column showed a
// heading typed only once closed and opened again. The default schedule,
// `queueMicrotask` kept as a method and called as one, threw "Illegal
// invocation" in a browser at every change (CodeMirror logs a listener's
// error and goes on); jsdom's lets any `this` through. A browser's, here:
// only the window's own `this`.
describe("with a browser's queueMicrotask", () => {
  test("the listeners are told of a heading typed", async () => {
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = function (
      this: unknown,
      callback: VoidFunction,
    ) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      original(callback);
    };
    try {
      const { index, edit } = indexed("# One\n");
      let told = 0;
      index.subscribe(() => told++);
      edit(6, 6, "## Two\n");
      await Promise.resolve();
      expect(told).toBe(1);
      expect(index.current().map((h) => h.text)).toEqual(["One", "Two"]);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });
});
