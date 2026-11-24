// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, test } from "vitest";
import { counter, resetCounters } from "../perf/index.js";
import { TITLE_SCAN, documentTitle, watchTitle } from "./document-title.js";

beforeEach(() => resetCounters());

describe("documentTitle (phase 10, analysis 10b.1)", () => {
  test("the first Markdown heading, of any level", () => {
    expect(documentTitle("intro\n\n## Notes du 2 octobre ##\n# Later")).toBe(
      "Notes du 2 octobre",
    );
    expect(documentTitle("# Compte rendu")).toBe("Compte rendu");
  });

  test("none without a heading, or one that only starts like one", () => {
    expect(documentTitle("just text\n#hashtag\n####### seven")).toBeUndefined();
    expect(documentTitle("")).toBeUndefined();
    expect(documentTitle("#   ")).toBeUndefined();
  });

  test("only in the first few kilobytes", () => {
    const far = `${"x".repeat(TITLE_SCAN)}\n# Too far`;
    expect(documentTitle(far)).toBeUndefined();
  });
});

describe("watchTitle", () => {
  function setUp(doc: string) {
    const view = new EditorView({ state: EditorState.create({ doc }) });
    const titles: (string | undefined)[] = [];
    watchTitle(view, (title) => titles.push(title));
    return { view, titles };
  }

  test("says the title at once, then each time it changes", () => {
    const { view, titles } = setUp("# One\n\ntext");
    view.dispatch({ changes: { from: 2, to: 5, insert: "Two" } });
    view.dispatch({ changes: { from: 9, insert: "more " } });
    expect(titles).toEqual(["One", "Two"]);
  });

  test("a change past the scanned start costs nothing", () => {
    const { view } = setUp(`# One\n${"x".repeat(TITLE_SCAN)}`);
    const before = counter("title.compute");
    view.dispatch({ changes: { from: TITLE_SCAN + 3, insert: "typing" } });
    expect(counter("title.compute")).toBe(before);
  });
});
