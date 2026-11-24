// Finding a heading asked for (docs/phase-16-plan-du-document.md,
// decision 8): by its raw text, level and occurrence, so that a heading
// named by a late export, or by a list of an earlier version, is still
// found once others came or went.

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { type HeadingTarget, resolveHeading, targetOf } from "./resolve.js";

const SOURCES = ["A", "B", "C", "A b", ""];

const headingGen = gs.tuples(
  gs.sampledFrom(SOURCES),
  gs.integers({ minValue: 1, maxValue: 3 }),
);
const headingsGen = gs.arrays(headingGen, { maxSize: 10 });

const asHeadings = (pairs: [string, number][]) =>
  pairs.map(([source, level]) => ({ source, level }));

describe("resolveHeading", () => {
  test("the same occurrence of the same text at the same level", () => {
    const headings = asHeadings([
      ["A", 1],
      ["B", 2],
      ["A", 1],
      ["A", 2],
    ]);
    expect(
      resolveHeading(headings, { source: "A", level: 1, occurrence: 1 }),
    ).toBe(2);
    expect(
      resolveHeading(headings, { source: "A", level: 2, occurrence: 0 }),
    ).toBe(3);
  });

  test("an occurrence there is no longer: the last of that text at that level", () => {
    const headings = asHeadings([
      ["A", 1],
      ["A", 1],
    ]);
    expect(
      resolveHeading(headings, { source: "A", level: 1, occurrence: 5 }),
    ).toBe(1);
  });

  test("a level changed: the first of that text", () => {
    const headings = asHeadings([
      ["B", 1],
      ["A", 3],
      ["A", 2],
    ]);
    expect(
      resolveHeading(headings, { source: "A", level: 1, occurrence: 0 }),
    ).toBe(1);
  });

  test("a text there is no longer: none", () => {
    expect(
      resolveHeading(asHeadings([["B", 1]]), {
        source: "A",
        level: 1,
        occurrence: 0,
      }),
    ).toBeUndefined();
  });

  test("a heading of the list is found as it is", () =>
    hegel.test(
      (tc) => {
        const headings = asHeadings(tc.draw(headingsGen));
        tc.assume(headings.length > 0);
        const i = tc.draw(
          gs.integers({ minValue: 0, maxValue: headings.length - 1 }),
        );
        const found = resolveHeading(headings, targetOf(headings, i));
        if (found !== i) throw new Error(`asked ${i}, found ${found}`);
      },
      { testCases: 300 },
    ));

  test("still found once headings of another text or level came or went", () =>
    hegel.test(
      (tc) => {
        const before = tc.draw(headingsGen).map(([source, level], id) => ({
          source,
          level,
          id,
        }));
        tc.assume(before.length > 0);
        const i = tc.draw(
          gs.integers({ minValue: 0, maxValue: before.length - 1 }),
        );
        const asked = before[i] as (typeof before)[number];
        const target: HeadingTarget = targetOf(before, i);
        const other = (h: { source: string; level: number }) =>
          h.source !== asked.source || h.level !== asked.level;
        // Others removed, others inserted anywhere.
        const after = before.filter((h) => !other(h) || tc.draw(gs.booleans()));
        const inserts = tc.draw(gs.arrays(headingGen, { maxSize: 4 }));
        for (const [source, level] of inserts) {
          const inserted = { source, level, id: -1 };
          if (!other(inserted)) continue;
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: after.length }),
          );
          after.splice(at, 0, inserted);
        }
        const found = resolveHeading(after, target);
        if (found === undefined || after[found]?.id !== asked.id) {
          throw new Error(
            `asked ${JSON.stringify(asked)} in ${JSON.stringify(after)}, found ${found}`,
          );
        }
      },
      { testCases: 300 },
    ));
});
