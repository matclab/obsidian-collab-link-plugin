import { describe, expect, test } from "vitest";
import {
  classifyOverlap,
  findCreationConflict,
  findCrossingConflicts,
} from "./overlap.js";

describe("classifyOverlap", () => {
  test("two ranges that don't touch at all are disjoint", () => {
    expect(classifyOverlap({ start: 0, end: 5 }, { start: 10, end: 15 })).toBe(
      "disjoint",
    );
  });

  test("two ranges that touch exactly at the boundary are disjoint (half-open)", () => {
    expect(classifyOverlap({ start: 0, end: 5 }, { start: 5, end: 10 })).toBe(
      "disjoint",
    );
  });

  test("a range entirely inside another is nested", () => {
    expect(classifyOverlap({ start: 0, end: 10 }, { start: 2, end: 5 })).toBe(
      "nested",
    );
    expect(classifyOverlap({ start: 2, end: 5 }, { start: 0, end: 10 })).toBe(
      "nested",
    );
  });

  test("two identical ranges are nested", () => {
    expect(classifyOverlap({ start: 2, end: 5 }, { start: 2, end: 5 })).toBe(
      "nested",
    );
  });

  test("two ranges that partially overlap, neither containing the other, are crossing", () => {
    expect(classifyOverlap({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(
      "crossing",
    );
  });

  // Found by overlap.property.test.ts: a zero-width range sitting exactly on
  // another range's start or end boundary must classify the same way at
  // both ends (nested), not "disjoint" at one and "nested" at the other.
  test("a zero-width range at either boundary of another range is nested, consistently", () => {
    expect(classifyOverlap({ start: 0, end: 2 }, { start: 0, end: 0 })).toBe(
      "nested",
    );
    expect(classifyOverlap({ start: 0, end: 2 }, { start: 2, end: 2 })).toBe(
      "nested",
    );
    expect(classifyOverlap({ start: 0, end: 2 }, { start: 1, end: 1 })).toBe(
      "nested",
    );
  });
});

describe("findCrossingConflicts", () => {
  test("finds exactly the crossing pairs among a mix of disjoint, nested and crossing annotations", () => {
    const annotations = [
      { id: "d1", range: { start: 0, end: 5 } },
      { id: "d2", range: { start: 100, end: 105 } }, // disjoint from everything
      { id: "outer", range: { start: 20, end: 40 } },
      { id: "inner", range: { start: 25, end: 30 } }, // nested inside outer
      { id: "x1", range: { start: 50, end: 60 } },
      { id: "x2", range: { start: 55, end: 65 } }, // crosses x1
    ];

    const conflicts = findCrossingConflicts(annotations);

    expect(conflicts).toHaveLength(1);
    const pair = conflicts[0];
    expect(pair).toBeDefined();
    expect(new Set([pair?.a, pair?.b])).toEqual(new Set(["x1", "x2"]));
  });
});

describe("findCreationConflict", () => {
  test("returns undefined when the proposed range is disjoint or nested against every existing annotation", () => {
    const existing = [
      { id: "e1", range: { start: 0, end: 5 } },
      { id: "e2", range: { start: 20, end: 30 } },
    ];
    expect(
      findCreationConflict(existing, { start: 10, end: 15 }),
    ).toBeUndefined();
    expect(
      findCreationConflict(existing, { start: 21, end: 25 }),
    ).toBeUndefined();
  });

  test("returns the id of the existing annotation the proposed range would cross", () => {
    const existing = [
      { id: "e1", range: { start: 0, end: 10 } },
      { id: "e2", range: { start: 20, end: 30 } },
    ];
    expect(findCreationConflict(existing, { start: 5, end: 25 })).toBe("e1");
  });
});
