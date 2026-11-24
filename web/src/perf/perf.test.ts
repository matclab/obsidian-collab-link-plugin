import { describe, expect, test } from "vitest";
import {
  count,
  countDuring,
  counter,
  enableMarks,
  resetCounters,
  resetTimings,
  span,
  timings,
} from "./index.js";

describe("counters", () => {
  test("count adds up per name, and reset clears every name", () => {
    resetCounters();
    count("cursor.resolve");
    count("cursor.resolve", 3);
    count("panel.render");
    expect(counter("cursor.resolve")).toBe(4);
    expect(counter("panel.render")).toBe(1);
    resetCounters();
    expect(counter("cursor.resolve")).toBe(0);
  });

  test("countDuring reports only the increments made while running", () => {
    count("loro.import", 5);
    expect(countDuring("loro.import", () => count("loro.import", 2))).toBe(2);
  });
});

describe("spans", () => {
  test("a span returns its result, and once enabled becomes a named measure", () => {
    expect(span("before", () => 41 + 1)).toBe(42);
    expect(performance.getEntriesByName("oc:before")).toHaveLength(0);
    expect(timings()).toEqual({});

    enableMarks();
    resetTimings();
    span("work", () => undefined);
    span("work", () => undefined);

    expect(performance.getEntriesByName("oc:work")).toHaveLength(2);
    expect(timings().work?.calls).toBe(2);
  });

  test("a span that throws still ends its measure", () => {
    enableMarks();
    expect(() =>
      span("failing", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(performance.getEntriesByName("oc:failing")).toHaveLength(1);
  });
});
