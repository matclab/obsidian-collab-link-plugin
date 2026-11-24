import { describe, expect, test } from "vitest";
import { type Direction, moveSection } from "./move-section.js";
import { outlineOfText } from "./outline.js";

/** The text once the section at `pos` moved, or undefined. */
function moved(text: string, pos: number, direction: Direction) {
  const move = moveSection(text, outlineOfText(text), pos, direction);
  if (!move) return undefined;
  let result = text;
  // Applied as CodeMirror does: positions in the text before.
  for (const change of [...move.changes].sort((a, b) => b.from - a.from)) {
    result =
      result.slice(0, change.from) +
      change.insert +
      result.slice(change.to ?? change.from);
  }
  return { text: result, headingAt: move.headingAt };
}

describe("moving a section (phase 17, decision 7)", () => {
  const doc = "Intro\n# A\na\n## A1\nx\n# B\nb\n# C\nc\n";

  test("up: before the section of the same level above, its subsections with it", () => {
    const at = doc.indexOf("# B");
    expect(moved(doc, at + 2, "up")).toEqual({
      text: "Intro\n# B\nb\n# A\na\n## A1\nx\n# C\nc\n",
      headingAt: doc.indexOf("# A"),
    });
  });

  test("down: after the section of the same level below", () => {
    const at = doc.indexOf("a\n## A1");
    expect(moved(doc, at, "down")?.text).toBe(
      "Intro\n# B\nb\n# A\na\n## A1\nx\n# C\nc\n",
    );
  });

  test("the caret anywhere in it, a subsection's text included, moves its own section", () => {
    const at = doc.indexOf("x\n");
    // In A1: no sibling of its level below, inside A.
    expect(moved(doc, at, "down")).toBeUndefined();
    expect(moved(doc, at, "up")).toBeUndefined();
  });

  test("the last section, without a final line break, moved up", () => {
    const text = "# A\na\n# B\nb";
    expect(moved(text, text.indexOf("b"), "up")?.text).toBe("# B\nb\n# A\na");
  });

  test("down, to the end of a text without a final line break", () => {
    const text = "# A\na\n# B\nb";
    expect(moved(text, 0, "down")?.text).toBe("# B\nb\n# A\na");
  });

  test("nothing before the first heading, nor past the first or last of a level", () => {
    expect(moved(doc, 0, "up")).toBeUndefined();
    expect(moved(doc, doc.indexOf("# A"), "up")).toBeUndefined();
    expect(moved(doc, doc.indexOf("# C"), "down")).toBeUndefined();
  });

  test("never out of its parent section", () => {
    const text = "# A\n## A1\n# B\n## B1\n";
    expect(moved(text, text.indexOf("## B1"), "up")).toBeUndefined();
    expect(moved(text, text.indexOf("## A1"), "down")).toBeUndefined();
  });
});

describe("the final line break", () => {
  test("stays at the end of the text, whichever section ends it", () => {
    const text = "# A\na\n# B\nb\n";
    expect(moved(text, text.indexOf("b"), "up")?.text).toBe("# B\nb\n# A\na\n");
    expect(moved(text, 0, "down")?.text).toBe("# B\nb\n# A\na\n");
  });

  test("a blank line ending a section stays in place, the last one moved", () => {
    const text = "### T0\n\n### T1";
    const up = moved(text, text.length, "up");
    expect(up?.text).toBe("### T1\n\n### T0");
  });
});

describe("the blank lines between sections stay in place", () => {
  test("the last section moved up, then down again", () => {
    const text = "# Un\n\nTexte un.\n\n# Deux\n\nTexte deux.\n";
    const swapped = "# Deux\n\nTexte deux.\n\n# Un\n\nTexte un.\n";
    expect(moved(text, text.indexOf("deux"), "up")?.text).toBe(swapped);
    expect(moved(text, 0, "down")?.text).toBe(swapped);
    expect(moved(swapped, 0, "down")?.text).toBe(text);
  });

  test("each gap keeps its own blank lines", () => {
    const text = "# A\na\n\n\n# B\nb\n# C\n";
    expect(moved(text, text.indexOf("b"), "up")).toEqual({
      text: "# B\nb\n\n\n# A\na\n# C\n",
      headingAt: 0,
    });
    expect(moved(text, 0, "down")).toEqual({
      text: "# B\nb\n\n\n# A\na\n# C\n",
      headingAt: "# B\nb\n\n\n".length,
    });
  });
});

describe("what would change the text's meaning is refused", () => {
  test("a setext heading after a paragraph, which it would continue", () => {
    const text = "\nT0\n===\n# T1\ntexte";
    expect(moved(text, 1, "down")).toBeUndefined();
  });

  test("a code block left open, which would take the sections after it", () => {
    const text = "# A\na\n# B\n```\ncode";
    expect(moved(text, text.indexOf("# B"), "up")).toBeUndefined();
  });
});
