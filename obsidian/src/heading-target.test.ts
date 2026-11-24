import { describe, expect, test } from "vitest";
import { ephemeralRequest, targetFor } from "./heading-target.js";

const heading = (line: number, level: number, text: string) => ({
  heading: text,
  level,
  position: {
    start: { line, col: 0, offset: 0 },
    end: { line, col: 0, offset: 0 },
  },
});

// A file with its YAML header (4 lines): "# A" at line 4, and so on.
const HEADINGS = [
  heading(4, 1, "A"),
  heading(8, 2, "*B*  text"),
  heading(12, 2, "A"),
  heading(16, 1, "A"),
];
const noSubpath = () => undefined;

describe("ephemeralRequest", () => {
  test("reads a line, a heading's subpath, the focus", () => {
    expect(ephemeralRequest({ line: 12 })).toEqual({ focus: false, line: 12 });
    expect(ephemeralRequest({ subpath: "#A" })).toEqual({
      focus: false,
      subpath: "#A",
    });
    expect(ephemeralRequest({ focus: true })).toEqual({ focus: true });
  });

  test("nothing else: a block, a search match, a scroll, nonsense", () => {
    expect(ephemeralRequest({ subpath: "#^block" })).toBeUndefined();
    expect(ephemeralRequest({ match: { content: "x" } })).toBeUndefined();
    expect(ephemeralRequest({ scroll: 3 })).toBeUndefined();
    expect(ephemeralRequest(undefined)).toBeUndefined();
    expect(ephemeralRequest("x")).toBeUndefined();
    expect(ephemeralRequest({ line: -1 })).toBeUndefined();
    expect(ephemeralRequest({ line: 1.5 })).toBeUndefined();
  });
});

describe("targetFor", () => {
  test("the heading at a line: its raw text, level, occurrence", () => {
    expect(targetFor(HEADINGS, { line: 12 }, noSubpath)).toEqual({
      source: "A",
      level: 2,
      occurrence: 0,
    });
    expect(targetFor(HEADINGS, { line: 16 }, noSubpath)).toEqual({
      source: "A",
      level: 1,
      occurrence: 1,
    });
  });

  test("a line within a section: its heading; above the first: none", () => {
    expect(targetFor(HEADINGS, { line: 10 }, noSubpath)?.source).toBe(
      "*B* text",
    );
    expect(targetFor(HEADINGS, { line: 2 }, noSubpath)).toBeUndefined();
  });

  test("a subpath, as Obsidian resolves it", () => {
    const resolve = (subpath: string) =>
      subpath === "#A#A" ? HEADINGS[2] : undefined;
    expect(targetFor(HEADINGS, { subpath: "#A#A" }, resolve)).toEqual({
      source: "A",
      level: 2,
      occurrence: 0,
    });
    expect(targetFor(HEADINGS, { subpath: "#Nope" }, resolve)).toBeUndefined();
  });

  test("no headings known: none", () => {
    expect(targetFor(undefined, { line: 4 }, noSubpath)).toBeUndefined();
  });
});
