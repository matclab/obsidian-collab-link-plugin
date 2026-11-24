import { Text } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { type OutlineHeading, outlineOfText } from "./outline.js";

const brief = (headings: readonly OutlineHeading[]) =>
  headings.map(({ level, text, source, line }) => ({
    level,
    text,
    source,
    line,
  }));

describe("outlineOfText", () => {
  test("lists ATX and Setext headings, their level, line and start", () => {
    const text = "# One\n\npara\n\nTwo\n===\n\n### Three\nThree b\n---";
    const headings = outlineOfText(text);
    expect(brief(headings)).toEqual([
      { level: 1, text: "One", source: "One", line: 0 },
      { level: 1, text: "Two", source: "Two", line: 4 },
      { level: 3, text: "Three", source: "Three", line: 7 },
      { level: 2, text: "Three b", source: "Three b", line: 8 },
    ]);
    expect(headings.map((h) => h.from)).toEqual([
      0,
      text.indexOf("Two"),
      text.indexOf("###"),
      text.indexOf("Three b"),
    ]);
  });

  test("the source is the heading's raw text, as Obsidian's metadataCache gives it", () => {
    // choice/obsidian/outline/results/lists.json
    const headings = outlineOfText(
      [
        "## Closed ##",
        "",
        "##",
        "",
        "   ### Three spaces",
        "",
        "## *Emphasis* `code` [link](https://x.org) $x^2$ \\* &amp;",
      ].join("\n"),
    );
    expect(headings.map((h) => h.source)).toEqual([
      "Closed",
      "",
      "Three spaces",
      "*Emphasis* `code` [link](https://x.org) $x^2$ \\* &amp;",
    ]);
  });

  test("the text is what the preview shows of the heading", () => {
    const [heading] = outlineOfText(
      "## *Emphasis* `code` [link](https://x.org) $x^2$ \\* ~~gone~~",
    );
    expect(heading?.text).toBe("Emphasis code link x^2 * gone");
  });

  test("a heading's text over several lines is one line", () => {
    const [heading] = outlineOfText("One\n  two\n===");
    expect(heading).toMatchObject({ text: "One two", source: "One two" });
  });

  test("only the document's own headings: none in a quote, a callout, a list, code or HTML", () => {
    // As Obsidian's outline (choice/obsidian/outline/results/lists.json).
    const text = [
      "# Top",
      "",
      "- # In a bullet item",
      "",
      "1. ## In a numbered item",
      "",
      "- item",
      "",
      "  ## In an item, indented",
      "",
      "> ## In a quote",
      "",
      "> [!note]",
      "> ## In a callout",
      "",
      "    # In indented code",
      "",
      "```",
      "# In fenced code",
      "```",
      "",
      "#No space",
      "",
      "<div>",
      "# After an HTML block line",
      "</div>",
      "",
      "## Last",
    ].join("\n");
    expect(outlineOfText(text).map((h) => h.text)).toEqual(["Top", "Last"]);
  });

  test("a note's YAML header is not a heading", () => {
    expect(
      outlineOfText("---\ntitle: x\n---\n# After").map((h) => h.line),
    ).toEqual([3]);
  });

  test("no heading: an empty outline", () => {
    expect(outlineOfText("")).toEqual([]);
    expect(outlineOfText("just text\n\n- a list")).toEqual([]);
  });
});

// Found by the outline's property after phase 17's merge: @lezer/markdown
// made a table followed by a setext underline a heading, where the
// preview's markdown-it keeps the table (`===` a row, `---` a rule after
// it) — when its delimiter row has the header's columns; otherwise both
// read a paragraph, then a heading.
describe("a table, then a setext underline", () => {
  test("is no heading when the preview reads a table", () => {
    for (const text of [
      "|a|b|\n|-|-|\n===",
      "a|b\n-|-\n===",
      "|a|b|\n|-|-|\n|c|d|\n===",
      "|a|b|\n|-|-|\n---",
    ]) {
      expect(outlineOfText(text), text).toEqual([]);
    }
  });

  test("is a heading when the delimiter row doesn't match its header", () => {
    expect(outlineOfText("|a|b|\n|-|\n===").map((h) => h.level)).toEqual([1]);
    expect(outlineOfText("|a|\n===").map((h) => h.level)).toEqual([1]);
  });
});
