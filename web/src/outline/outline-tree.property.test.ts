// The outline's tree against a model on the flat list (ADR-0062): a
// heading's ancestors are, from it backwards, each nearest heading of a
// lower level than the last found.

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  type TreeItem,
  collapseToDepth,
  keysOf,
  nest,
  shownCurrent,
  treeDepth,
} from "./outline-tree.js";

const headingsGen = gs.arrays(
  gs.tuples(
    gs.sampledFrom(["A", "B", "C"]),
    gs.integers({ minValue: 1, maxValue: 6 }),
  ),
  { maxSize: 14 },
);

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

/** The ranks of `i`'s ancestors, closest first. */
function ancestors(items: readonly TreeItem[], i: number): number[] {
  const found: number[] = [];
  let level = (items[i] as TreeItem).level;
  for (let j = i - 1; j >= 0; j--) {
    const other = items[j] as TreeItem;
    if (other.level < level) {
      found.push(j);
      level = other.level;
    }
  }
  return found;
}

const hasChildren = (items: readonly TreeItem[], i: number) =>
  items.some((_, j) => j > i && ancestors(items, j).includes(i));

describe("the outline's tree, against the flat list", () => {
  test("depths, descendants and the deepest depth", () =>
    hegel.test(
      (tc) => {
        const items = itemsOf(tc.draw(headingsGen));
        const nodes = new Map<number, ReturnType<typeof nest>[number]>();
        const visit = (list: ReturnType<typeof nest>) => {
          for (const node of list) {
            nodes.set(node.item.index, node);
            visit(node.children);
          }
        };
        const tree = nest(items);
        visit(tree);
        let deepest = 0;
        items.forEach((_, i) => {
          const depth = ancestors(items, i).length + 1;
          deepest = Math.max(deepest, depth);
          const descendants = items.filter((__, j) =>
            ancestors(items, j).includes(i),
          ).length;
          const node = nodes.get(i);
          if (node?.depth !== depth || node.descendants !== descendants)
            throw new Error(
              `${i}: depth ${node?.depth} for ${depth}, ${node?.descendants} under for ${descendants}`,
            );
        });
        if (treeDepth(tree) !== deepest)
          throw new Error(`deepest ${treeDepth(tree)} for ${deepest}`);
      },
      { testCases: 300 },
    ));

  test("the heading marked is the one read, or its outermost folded ancestor (PV7)", () =>
    hegel.test(
      (tc) => {
        const items = itemsOf(tc.draw(headingsGen));
        tc.assume(items.length > 0);
        const collapsed = new Set(
          items.filter(() => tc.draw(gs.booleans())).map((item) => item.key),
        );
        const current = tc.draw(
          gs.integers({ minValue: 0, maxValue: items.length - 1 }),
        );
        const folded = ancestors(items, current).filter((j) =>
          collapsed.has((items[j] as TreeItem).key),
        );
        const expected = folded.length > 0 ? folded.at(-1) : current;
        const marked = shownCurrent(nest(items), collapsed, current);
        if (marked !== expected)
          throw new Error(`marked ${marked}, expected ${expected}`);
      },
      { testCases: 300 },
    ));

  test("« Levels k »: the headings shown are those of depth k or less (PV5)", () =>
    hegel.test(
      (tc) => {
        const items = itemsOf(tc.draw(headingsGen));
        const tree = nest(items);
        const k = tc.draw(
          gs.integers({ minValue: 1, maxValue: Math.max(1, treeDepth(tree)) }),
        );
        const collapsed = collapseToDepth(tree, k);
        items.forEach((item, i) => {
          const above = ancestors(items, i);
          const shown = !above.some((j) =>
            collapsed.has((items[j] as TreeItem).key),
          );
          if (shown !== above.length + 1 <= k)
            throw new Error(
              `${i} at depth ${above.length + 1}, shown ${shown}`,
            );
          // Only headings with children are folded.
          if (collapsed.has(item.key) && !hasChildren(items, i))
            throw new Error(`${i} folded without children`);
        });
      },
      { testCases: 300 },
    ));
});
