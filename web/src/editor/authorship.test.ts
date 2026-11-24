// @vitest-environment jsdom
// Who wrote, in the editor (ADR-0059 §5): each character's background by
// its person, read from Loro only for text not yet read — never for the
// page's own typing —, and nothing while off.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { registerPeers } from "../../lib/src/history/tables.js";
import { AuthorNames } from "../history/author-names.js";
import { counter, resetCounters } from "../perf/index.js";
import { attachAuthorship, authorMarks } from "./authorship.js";
import { createDocumentEditor } from "./editor.js";

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

function setUp() {
  const remote = new LoroDoc();
  remote.setPeerId(2n);
  remote.getText("content").insert(0, "hello world");
  remote.commit();
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  sync(remote, doc);
  const annotationsDoc = new LoroDoc();
  registerPeers(annotationsDoc, ["2"], "bob");
  const queue: (() => void)[] = [];
  const schedule = (run: () => void) => queue.push(run);
  const editor = createDocumentEditor(document.createElement("div"), doc);
  const names = new AuthorNames(annotationsDoc, schedule);
  const authorship = attachAuthorship(editor.view, doc, names, { schedule });
  const flush = () => {
    while (queue.length > 0) for (const run of queue.splice(0)) run();
  };
  /** Each mark's text and class. */
  const marks = () =>
    authorMarks(editor.view.state).map(({ from, to, className }) => [
      editor.view.state.sliceDoc(from, to),
      className,
    ]);
  return {
    remote,
    doc,
    annotationsDoc,
    editor,
    authorship,
    flush,
    queue,
    marks,
  };
}

describe("who wrote, in the editor", () => {
  test("off: no mark, and nothing read, typing or importing", () => {
    const { remote, doc, editor, flush, marks } = setUp();
    resetCounters();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    remote.getText("content").insert(0, "b");
    remote.commit();
    sync(remote, doc);
    flush();
    expect(marks()).toEqual([]);
    expect(counter("authorship.char")).toBe(0);
    expect(counter("authorship.order")).toBe(0);
  });

  test("on: every character by its person, once the work is done", () => {
    const { authorship, flush, marks, editor } = setUp();
    editor.view.dispatch({ changes: { from: 5, insert: "!" } });
    authorship.setOn(true);
    expect(marks()).toEqual([]);
    flush();
    // bob came first; the page's own peer has no name yet.
    expect(marks()).toEqual([
      ["hello", "cm-author cm-author-1"],
      ["!", "cm-author cm-author-unknown"],
      [" world", "cm-author cm-author-1"],
    ]);
  });

  test("the page's own typing is marked at once, nothing read", () => {
    const { authorship, flush, marks, editor, annotationsDoc } = setUp();
    registerPeers(annotationsDoc, ["1"], "alice");
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    authorship.setOn(true);
    flush();
    resetCounters();
    editor.view.dispatch({ changes: { from: 6, insert: "XY" } });
    expect(marks()).toEqual([
      ["a", "cm-author cm-author-2"],
      ["hello", "cm-author cm-author-1"],
      ["XY", "cm-author cm-author-2"],
      [" world", "cm-author cm-author-1"],
    ]);
    flush();
    expect(counter("authorship.char")).toBe(0);
  });

  // Found by the scenario when first run (draws: switch, run, type « a »
  // at 0): the mark after the typed text, which only touched it, was cut
  // and kept, twice.
  test("typing at the edge of a mark keeps that mark once", () => {
    const { authorship, flush, marks, editor } = setUp();
    authorship.setOn(true);
    flush();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    expect(marks()).toEqual([
      ["a", "cm-author cm-author-unknown"],
      ["hello world", "cm-author cm-author-1"],
    ]);
  });

  test("another's text: unmarked until read, and only it is read", () => {
    const { authorship, flush, marks, remote, doc } = setUp();
    authorship.setOn(true);
    flush();
    remote.getText("content").insert(5, ",");
    remote.commit();
    sync(remote, doc);
    expect(marks()).toEqual([
      ["hello", "cm-author cm-author-1"],
      [" world", "cm-author cm-author-1"],
    ]);
    resetCounters();
    flush();
    expect(counter("authorship.char")).toBe(1);
    expect(marks().map(([text]) => text)).toEqual(["hello", ",", " world"]);
  });

  test("a name that arrives colors its text", () => {
    const { authorship, flush, marks, editor, annotationsDoc } = setUp();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    authorship.setOn(true);
    flush();
    expect(marks()[0]).toEqual(["a", "cm-author cm-author-unknown"]);
    resetCounters();
    registerPeers(annotationsDoc, ["1"], "alice");
    flush();
    expect(marks()[0]).toEqual(["a", "cm-author cm-author-2"]);
    expect(counter("authorship.char")).toBe(0);
  });

  test("off again: every mark gone, nothing read after", () => {
    const { authorship, flush, marks, editor } = setUp();
    authorship.setOn(true);
    flush();
    authorship.setOn(false);
    expect(marks()).toEqual([]);
    resetCounters();
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    flush();
    expect(counter("authorship.char")).toBe(0);
  });

  test("stopped: a pending reading does nothing", () => {
    const { authorship, flush, marks } = setUp();
    authorship.setOn(true);
    authorship.destroy();
    resetCounters();
    flush();
    expect(marks()).toEqual([]);
    expect(counter("authorship.char")).toBe(0);
  });
});

describe("who wrote in the editor, its budget (AGENTS.md §6)", () => {
  /** A text of `lines` lines by another, shown with who wrote it. */
  function long(lines: number) {
    const remote = new LoroDoc();
    remote.setPeerId(2n);
    remote
      .getText("content")
      .insert(0, "word word word word word\n".repeat(lines));
    remote.commit();
    const doc = new LoroDoc();
    doc.setPeerId(1n);
    sync(remote, doc);
    const queue: (() => void)[] = [];
    const schedule = (run: () => void) => queue.push(run);
    const editor = createDocumentEditor(document.createElement("div"), doc);
    const authorship = attachAuthorship(
      editor.view,
      doc,
      new AuthorNames(new LoroDoc(), schedule),
      { schedule },
    );
    const flush = () => {
      while (queue.length > 0) for (const run of queue.splice(0)) run();
    };
    return { remote, doc, editor, authorship, flush };
  }

  test("switched on, reads the shown text, whatever the length of the rest", () => {
    const reads = (lines: number) => {
      const { editor, authorship, flush } = long(lines);
      resetCounters();
      authorship.setOn(true);
      flush();
      const shown = editor.view.visibleRanges.reduce(
        (sum, { from, to }) => sum + to - from,
        0,
      );
      expect(shown).toBeLessThan(editor.view.state.doc.length);
      expect(counter("authorship.char")).toBe(shown);
      return counter("authorship.char");
    };
    expect(reads(1600)).toBe(reads(400));
  });

  test("another's change: its text read, the persons ordered once", () => {
    const { remote, doc, authorship, flush } = long(400);
    authorship.setOn(true);
    flush();
    remote.getText("content").insert(3, "abc");
    remote.commit();
    resetCounters();
    sync(remote, doc);
    flush();
    expect(counter("authorship.char")).toBe(3);
    expect(counter("authorship.order")).toBe(1);
  });
});
