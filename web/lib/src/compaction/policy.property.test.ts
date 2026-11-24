import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { shouldCompact } from "./policy.js";

describe("shouldCompact property tests", () => {
  test("never crashes for arbitrary non-negative op counts and thresholds", () =>
    hegel.test((tc) => {
      const opsSinceLastCompaction = tc.draw(
        gs.integers({ minValue: 0, maxValue: 1_000_000 }),
      );
      const threshold = tc.draw(
        gs.integers({ minValue: 1, maxValue: 1_000_000 }),
      );

      shouldCompact(opsSinceLastCompaction, threshold);
    }));

  test("is monotonic: more ops never flips a true back to false", () =>
    hegel.test((tc) => {
      const threshold = tc.draw(gs.integers({ minValue: 1, maxValue: 10_000 }));
      const lower = tc.draw(gs.integers({ minValue: 0, maxValue: 10_000 }));
      const extra = tc.draw(gs.integers({ minValue: 0, maxValue: 10_000 }));
      const higher = lower + extra;

      if (
        shouldCompact(lower, threshold) &&
        !shouldCompact(higher, threshold)
      ) {
        throw new Error(
          `monotonicity violated: shouldCompact(${lower}) was true but shouldCompact(${higher}) was false, threshold=${threshold}`,
        );
      }
    }));

  test("the boundary is exactly at the threshold", () =>
    hegel.test((tc) => {
      const threshold = tc.draw(gs.integers({ minValue: 1, maxValue: 10_000 }));

      if (shouldCompact(threshold - 1, threshold) !== false) {
        throw new Error(
          `expected threshold-1 to be false for threshold=${threshold}`,
        );
      }
      if (shouldCompact(threshold, threshold) !== true) {
        throw new Error(
          `expected threshold to be true for threshold=${threshold}`,
        );
      }
    }));
});
