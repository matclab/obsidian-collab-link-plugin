import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { type ResolvedRange, classifyOverlap } from "./overlap.js";

function makeRange(tc: TestCase, maxEnd: number): ResolvedRange {
  const start = tc.draw(gs.integers({ minValue: 0, maxValue: maxEnd }));
  const end = tc.draw(gs.integers({ minValue: start, maxValue: maxEnd }));
  return { start, end };
}

/** Reference model, computed directly from the two intervals rather than
 * reusing any of classifyOverlap's own logic (ADR-0012's model-based
 * property). */
function referenceClassify(a: ResolvedRange, b: ResolvedRange) {
  const aInsideB = b.start <= a.start && a.end <= b.end;
  const bInsideA = a.start <= b.start && b.end <= a.end;
  if (aInsideB || bInsideA) return "nested" as const;
  if (a.end <= b.start || b.end <= a.start) return "disjoint" as const;
  return "crossing" as const;
}

describe("classifyOverlap property tests", () => {
  test("is symmetric", () =>
    hegel.test((tc) => {
      const a = makeRange(tc, 50);
      const b = makeRange(tc, 50);
      const ab = classifyOverlap(a, b);
      const ba = classifyOverlap(b, a);
      if (ab !== ba) {
        throw new Error(
          `classifyOverlap not symmetric: (a,b)=${ab} (b,a)=${ba}, a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
        );
      }
    }));

  test("matches a reference classification computed directly from the intervals", () =>
    hegel.test((tc) => {
      const a = makeRange(tc, 50);
      const b = makeRange(tc, 50);
      const actual = classifyOverlap(a, b);
      const expected = referenceClassify(a, b);
      if (actual !== expected) {
        throw new Error(
          `classifyOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${actual}, expected ${expected}`,
        );
      }
    }));
});
