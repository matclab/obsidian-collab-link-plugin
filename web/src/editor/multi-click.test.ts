import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { type Press, clickRange, sameSpot } from "./multi-click.js";

const state = EditorState.create({ doc: "Avec un lien, et  une cible.\nFin." });
const range = (pos: number, assoc: -1 | 1, clicks: number) => {
  const r = clickRange(state, pos, assoc, clicks);
  return state.sliceDoc(r.from, r.to);
};

describe("a double or triple click's range", () => {
  test("two clicks: the word, or the run of spaces or punctuation, at the position", () => {
    expect(range(18, 1, 2)).toBe("une");
    expect(range(21, -1, 2)).toBe("une");
    expect(range(16, 1, 2)).toBe("  ");
    expect(range(12, 1, 2)).toBe(",");
  });

  test("three clicks: the line and its break, the last one without", () => {
    expect(range(18, 1, 3)).toBe("Avec un lien, et  une cible.\n");
    expect(range(31, 1, 3)).toBe("Fin.");
  });
});

describe("a press at the first one's spot", () => {
  const first: Press = { x: 100, y: 50, pos: 18, assoc: 1 };
  test("within a few pixels of it", () => {
    expect(sameSpot(first, { clientX: 102, clientY: 47 })).toBe(true);
    expect(sameSpot(first, { clientX: 106, clientY: 50 })).toBe(false);
    expect(sameSpot(undefined, { clientX: 100, clientY: 50 })).toBe(false);
  });
});
