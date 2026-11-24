import { describe, expect, test } from "vitest";
import {
  type TreeItem,
  collapseToDepth,
  keysOf,
  nest,
  setDepthCollapsed,
  shownCurrent,
  treeDepth,
} from "./outline-tree.js";
import { targetOf } from "./resolve.js";

/** Items from `[source, level]` pairs, keyed as the column keys them. */
function itemsOf(pairs: [string, number][]): TreeItem[] {
  const headings = pairs.map(([source, level]) => ({ source, level }));
  const keys = keysOf(headings);
  return headings.map(({ source, level }, index) => ({
    index,
    level,
    text: source,
    key: keys[index] as string,
  }));
}

const DOC: [string, number][] = [
  ["Intro", 1], // 0
  ["Context", 2], // 1
  ["Goals", 3], // 2
  ["Design", 1], // 3
  ["Parts", 2], // 4
  ["Store", 3], // 5
  ["Detail", 4], // 6
  ["Wire", 3], // 7
  ["End", 1], // 8
];

describe("the outline's tree (ADR-0062)", () => {
  test("nested by level, each under the last of a lower level; depth from 1, descendants counted", () => {
    const tree = nest(itemsOf(DOC));
    expect(tree.map((node) => node.item.text)).toEqual([
      "Intro",
      "Design",
      "End",
    ]);
    const design = tree[1];
    expect(design?.depth).toBe(1);
    expect(design?.descendants).toBe(4);
    const parts = design?.children[0];
    expect(parts?.depth).toBe(2);
    expect(parts?.children.map((node) => node.item.text)).toEqual([
      "Store",
      "Wire",
    ]);
    expect(parts?.children[0]?.children[0]?.depth).toBe(4);
    expect(treeDepth(tree)).toBe(4);
  });

  // A document opening with `##`: its `##` at depth 1; a `###` right
  // under a `#` at depth 2.
  test("depth is the tree's, not the heading's level", () => {
    const tree = nest(
      itemsOf([
        ["A", 2],
        ["B", 4],
        ["C", 2],
      ]),
    );
    expect(tree.map((node) => node.depth)).toEqual([1, 1]);
    expect(tree[0]?.children[0]?.depth).toBe(2);
    expect(treeDepth(tree)).toBe(2);
    expect(treeDepth([])).toBe(0);
  });

  test("a heading's key: its raw text, level and occurrence, as a heading asked for (PV6)", () => {
    const headings = [
      { source: "A", level: 1 },
      { source: "A", level: 2 },
      { source: "A", level: 1 },
      { source: "B", level: 1 },
    ];
    const keys = keysOf(headings);
    expect(new Set(keys).size).toBe(4);
    headings.forEach((_, i) =>
      expect(keys[i]).toBe(JSON.stringify(targetOf(headings, i))),
    );
  });

  test("a heading added above by another: the folded one keeps its key (PV6)", () => {
    const before = itemsOf(DOC);
    const folded = before[4]?.key as string;
    const after = itemsOf([["New", 1], ...DOC]);
    expect(after[5]?.text).toBe("Parts");
    expect(after[5]?.key).toBe(folded);
  });

  test("the heading read, under a folded branch: its closest shown ancestor (PV7)", () => {
    const items = itemsOf(DOC);
    const tree = nest(items);
    const key = (i: number) => items[i]?.key as string;
    expect(shownCurrent(tree, new Set(), 6)).toBe(6);
    expect(shownCurrent(tree, new Set([key(5)]), 6)).toBe(5);
    expect(shownCurrent(tree, new Set([key(4), key(5)]), 6)).toBe(4);
    expect(shownCurrent(tree, new Set([key(3), key(5)]), 6)).toBe(3);
    // Folding a heading leaves it shown, itself marked.
    expect(shownCurrent(tree, new Set([key(4)]), 4)).toBe(4);
    expect(shownCurrent(tree, new Set([key(4)]), undefined)).toBeUndefined();
    // Not in the tree (an empty heading, left out): none.
    expect(shownCurrent(tree, new Set(), 42)).toBeUndefined();
  });

  test("« Levels k »: every heading with children at depth k or deeper folded (PV5)", () => {
    const items = itemsOf(DOC);
    const tree = nest(items);
    const keys = (...at: number[]) => new Set(at.map((i) => items[i]?.key));
    expect(collapseToDepth(tree, 1)).toEqual(keys(0, 3, 1, 4, 5));
    expect(collapseToDepth(tree, 2)).toEqual(keys(1, 4, 5));
    expect(collapseToDepth(tree, 3)).toEqual(keys(5));
    expect(collapseToDepth(tree, 4)).toEqual(keys());
  });

  test("Alt+click: every heading with children at that depth folded or unfolded, the others as they were (PV4)", () => {
    const items = itemsOf([
      ["A", 1],
      ["A1", 2],
      ["A1a", 3],
      ["B", 1],
      ["B1", 2],
      ["B1a", 3],
      ["C", 1],
    ]);
    const tree = nest(items);
    const key = (i: number) => items[i]?.key as string;
    const start = new Set([key(1)]);
    const folded = setDepthCollapsed(tree, start, 1, true);
    expect(folded).toEqual(new Set([key(1), key(0), key(3)]));
    // C has no children: never in the set.
    expect(folded.has(key(6))).toBe(false);
    expect(setDepthCollapsed(tree, folded, 1, false)).toEqual(
      new Set([key(1)]),
    );
    expect(setDepthCollapsed(tree, start, 2, false)).toEqual(new Set());
    // The set given is left as it was.
    expect(start).toEqual(new Set([key(1)]));
  });
});
