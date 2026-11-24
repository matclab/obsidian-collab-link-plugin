// The side-by-side view (phase 11, decision 11): the editor and the
// rendering scroll together, matched by the source lines each rendered
// block carries (`data-line`, `data-line-end`, phase 10e).
import { describe, expect, test } from "vitest";
import { previewOffset, sourceLine } from "./scroll-map.js";

// Lines 0–1 a title, 2 blank, 3–6 a table, 7 blank, 8 a paragraph.
const blocks = [
  { line: 0, lineEnd: 2, top: 0, bottom: 40 },
  { line: 3, lineEnd: 7, top: 60, bottom: 180 },
  { line: 8, lineEnd: 9, top: 200, bottom: 230 },
];

describe("previewOffset", () => {
  test("nothing rendered: the top", () => {
    expect(previewOffset([], 0)).toBe(0);
    expect(previewOffset([], 12.5)).toBe(0);
  });

  test("a block's first line at its top, its end at its bottom", () => {
    expect(previewOffset(blocks, 3)).toBe(60);
    expect(previewOffset(blocks, 7)).toBe(180);
  });

  test("within a block, in proportion to its lines", () => {
    expect(previewOffset(blocks, 4.5)).toBe(105);
    expect(previewOffset(blocks, 1)).toBe(20);
  });

  test("a blank line between blocks, between the two", () => {
    expect(previewOffset(blocks, 2.5)).toBe(50);
  });

  test("past the last block: its bottom", () => {
    expect(previewOffset(blocks, 40)).toBe(230);
  });

  test("above the first block (a margin, blank lines): its top", () => {
    const lower = [{ line: 4, lineEnd: 5, top: 10, bottom: 30 }];
    expect(previewOffset(lower, 0)).toBe(10);
    expect(previewOffset(lower, 2)).toBe(10);
    expect(sourceLine(lower, 3)).toBe(4);
  });

  test("blocks out of order or overlapping never send it back up", () => {
    const tangled = [
      { line: 5, lineEnd: 9, top: 100, bottom: 200 },
      { line: 2, lineEnd: 6, top: 50, bottom: 300 },
      { line: 9, lineEnd: 10, top: 150, bottom: 160 },
    ];
    let last = 0;
    for (let line = 0; line <= 12; line += 0.25) {
      const at = previewOffset(tangled, line);
      expect(at).toBeGreaterThanOrEqual(last);
      last = at;
    }
  });
});

describe("sourceLine", () => {
  test("nothing rendered: the first line", () => {
    expect(sourceLine([], 0)).toBe(0);
    expect(sourceLine([], 500)).toBe(0);
  });

  test("the reverse of previewOffset within a block", () => {
    expect(sourceLine(blocks, 105)).toBe(4.5);
    expect(sourceLine(blocks, 60)).toBe(3);
  });

  test("between two blocks with no line between them: the next block's line", () => {
    const touching = [
      { line: 0, lineEnd: 2, top: 0, bottom: 40 },
      { line: 2, lineEnd: 3, top: 56, bottom: 80 },
    ];
    expect(sourceLine(touching, 48)).toBe(2);
  });

  test("past the last block: its end", () => {
    expect(sourceLine(blocks, 1000)).toBe(9);
  });
});
