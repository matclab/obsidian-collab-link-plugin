import { describe, expect, test } from "vitest";
import { stepAwaiting } from "./awaiting-nav.js";

// ‹ › over what awaits me (ADR-0050 §5): in the text's order, around.
describe("stepAwaiting", () => {
  const items = [
    { id: "b", start: 20 },
    { id: "a", start: 5 },
    { id: "c", start: 40 },
  ];
  test("the first in the text's order, when asked or nothing is active", () => {
    expect(stepAwaiting(items, undefined, 0)).toBe("a");
    expect(stepAwaiting(items, { id: "c", start: 40 }, 0)).toBe("a");
    expect(stepAwaiting(items, undefined, 1)).toBe("a");
    expect(stepAwaiting(items, undefined, -1)).toBe("c");
  });

  test("from an annotation of the list: the next or the previous, around", () => {
    expect(stepAwaiting(items, { id: "a", start: 5 }, 1)).toBe("b");
    expect(stepAwaiting(items, { id: "c", start: 40 }, 1)).toBe("a");
    expect(stepAwaiting(items, { id: "a", start: 5 }, -1)).toBe("c");
  });

  test("from another annotation: the next one after it in the text, or before", () => {
    expect(stepAwaiting(items, { id: "x", start: 10 }, 1)).toBe("b");
    expect(stepAwaiting(items, { id: "x", start: 10 }, -1)).toBe("a");
    expect(stepAwaiting(items, { id: "x", start: 50 }, 1)).toBe("a");
    expect(stepAwaiting(items, { id: "x", start: 1 }, -1)).toBe("c");
  });

  test("none: nothing", () => {
    expect(stepAwaiting([], undefined, 1)).toBeUndefined();
  });

  test("passages at the same place: by id, all reached", () => {
    const same = [
      { id: "y", start: 3 },
      { id: "x", start: 3 },
    ];
    expect(stepAwaiting(same, undefined, 1)).toBe("x");
    expect(stepAwaiting(same, { id: "x", start: 3 }, 1)).toBe("y");
    expect(stepAwaiting(same, { id: "y", start: 3 }, 1)).toBe("x");
  });
});
