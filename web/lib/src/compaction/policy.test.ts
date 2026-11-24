import { describe, expect, test } from "vitest";
import { DEFAULT_COMPACTION_THRESHOLD, shouldCompact } from "./policy.js";

describe("shouldCompact", () => {
  test("is false below the default threshold", () => {
    expect(shouldCompact(DEFAULT_COMPACTION_THRESHOLD - 1)).toBe(false);
  });

  test("is true at the default threshold", () => {
    expect(shouldCompact(DEFAULT_COMPACTION_THRESHOLD)).toBe(true);
  });

  test("is false for zero ops", () => {
    expect(shouldCompact(0)).toBe(false);
  });

  test("respects a custom threshold", () => {
    expect(shouldCompact(5, 10)).toBe(false);
    expect(shouldCompact(10, 10)).toBe(true);
  });
});
