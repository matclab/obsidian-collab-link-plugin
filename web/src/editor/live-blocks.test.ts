// The formatted text's blocks (phase 11d, decision 6; analysis 11a.1,
// point 4, option (a)): tables and formula blocks replaced by their
// rendering, read from the top-level blocks only, a block shown as its
// source when the editor has the focus and the selection touches it.

import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Strikethrough, Table, TaskList } from "@lezer/markdown";
import { describe, expect, test } from "vitest";
import { countDuring } from "../perf/index.js";
import { type BlockSpec, liveBlocks } from "./live-blocks.js";
import type { Reveal } from "./live-reveal.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { mathExtension } from "./math-syntax.js";

function blocksOf(
  text: string,
  selection: { from: number; to: number }[] = [],
  focused = false,
  reveal: Reveal[] = [],
): BlockSpec[] {
  const state = EditorState.create({
    doc: text,
    extensions: [
      markdown({ extensions: [Table, Strikethrough, TaskList, mathExtension] }),
    ],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  return liveBlocks(tree, state.doc, selection, focused, (from, to) =>
    reveal.filter((range) => range.from <= to && from <= range.to),
  );
}

const TABLE = "| a | b |\n|---|---|\n| 1 | $x$ |";

describe("liveBlocks", () => {
  test("a table: its whole lines, its source", () => {
    const text = `Avant.\n\n${TABLE}\n\nAprès.`;
    const from = text.indexOf("|");
    expect(blocksOf(text)).toEqual([
      { kind: "table", from, to: from + TABLE.length, source: TABLE },
    ]);
  });

  test("a formula block, numbered or not, the rest of its closing line with it", () => {
    const text = "$$\nE = mc^2\n$$\n\n$$a$$ (1)\n\nfin";
    expect(
      blocksOf(text).map(({ kind, source, tag, from, to }) => [
        kind,
        source,
        tag,
        text.slice(from, to),
      ]),
    ).toEqual([
      ["math", "\nE = mc^2\n", undefined, "$$\nE = mc^2\n$$"],
      ["math", "a", "1", "$$a$$ (1)"],
    ]);
  });

  test("a table in a quote or a list item: its whole lines, its source without their markers, its place", () => {
    const quoted = `> ${TABLE.replace(/\n/g, "\n> ")}`;
    expect(blocksOf(quoted)).toEqual([
      { kind: "table", from: 0, to: quoted.length, source: TABLE, quote: 1 },
    ]);
    const item = `- item\n\n  ${TABLE.replace(/\n/g, "\n  ")}`;
    expect(blocksOf(item)).toEqual([
      {
        kind: "table",
        from: item.indexOf("  |"),
        to: item.length,
        source: TABLE,
        list: 0,
      },
    ]);
    const deep = `> - item\n>\n>   - sous\n>\n>     ${TABLE.replace(/\n/g, "\n>     ")}`;
    expect(
      blocksOf(deep).map(({ source, quote, list }) => [source, quote, list]),
    ).toEqual([[TABLE, 1, 1]]);
  });

  test("a table on its item's first line: rendered, its marker with it", () => {
    const text = "- | a |\n  |---|\n  | 1 |";
    expect(blocksOf(text)).toEqual([
      {
        kind: "table",
        from: 0,
        to: text.length,
        source: "| a |\n|---|\n| 1 |",
        list: 0,
        marker: "•",
      },
    ]);
    expect(
      blocksOf("> 3. | a |\n>    |---|").map(({ quote, list, marker }) => [
        quote,
        list,
        marker,
      ]),
    ).toEqual([[1, 0, "3."]]);
  });

  test("a nested table after other text on its first line, or with a lazy line, stays its source", () => {
    // A task's box before it: not a list marker alone.
    expect(blocksOf("- [ ] | a |\n  |---|")).toEqual([]);
    // A line without the quote's marker.
    expect(blocksOf("> | a |\n|---|")).toEqual([]);
  });

  test("a formula block in a quote or a list item: its TeX without the quotes' markers, its place", () => {
    const quoted = "> $$\n> x\n> $$";
    expect(blocksOf(quoted)).toEqual([
      { kind: "math", from: 0, to: quoted.length, source: "\nx\n", quote: 1 },
    ]);
    const item = "- item\n\n  $$\n  x\n  $$ (2)";
    expect(
      blocksOf(item).map((b) => [
        b.kind,
        b.source.trim(),
        b.tag,
        b.quote,
        b.list,
      ]),
    ).toEqual([["math", "x", "2", undefined, 0]]);
    const deep = "> - item\n>\n>   $$\n>   x\n>   $$";
    expect(
      blocksOf(deep).map((b) => [
        b.source.includes(">"),
        b.source.trim(),
        b.quote,
        b.list,
      ]),
    ).toEqual([[false, "x", 1, 0]]);
  });

  test("a block in a callout: its innermost callout's family, and a rule when a plain quote holds it in there (phase 15, decision 9)", () => {
    // The editor's own parser: it marks a callout's header.
    const placed = (text: string) => {
      const state = EditorState.create({
        doc: text,
        extensions: [markdownSyntax()],
      });
      const tree = ensureSyntaxTree(state, text.length, 5000);
      if (!tree) throw new Error("not parsed");
      return liveBlocks(tree, state.doc, [], false).map((b) => [
        b.kind,
        b.quote,
        b.callout,
      ]);
    };
    expect(placed("> [!warning] T\n> | a |\n> |---|\n> | 1 |")).toEqual([
      ["table", 1, { family: "warning", rule: false }],
    ]);
    // An alias, its family; an unknown type, a note's.
    expect(placed("> [!faq]\n>\n> $$\n> x\n> $$")).toEqual([
      ["math", 1, { family: "question", rule: false }],
    ]);
    expect(placed("> [!Mon Type]\n>\n> $$\n> x\n> $$")).toEqual([
      ["math", 1, { family: "note", rule: false }],
    ]);
    // A plain quote in a callout: its rule over the callout's colour.
    expect(placed("> [!tip] T\n>\n> > $$\n> > x\n> > $$")).toEqual([
      ["math", 2, { family: "tip", rule: true }],
    ]);
    // A callout in a quote, in a callout: the innermost one's.
    expect(placed("> q\n>\n> > [!bug]\n> >\n> > $$\n> > x\n> > $$")).toEqual([
      ["math", 2, { family: "bug", rule: false }],
    ]);
    expect(placed("> [!tip]\n> > [!danger]\n> > | a |\n> > |---|")).toEqual([
      ["table", 2, { family: "danger", rule: false }],
    ]);
    // A header that does not open a callout: a plain quote.
    expect(placed(">  [!note] x\n>\n> $$\n> x\n> $$")).toEqual([
      ["math", 1, undefined],
    ]);
    // In a list item in a callout.
    expect(placed("> [!info]\n>\n> - $$\n>   x\n>   $$")).toEqual([
      ["math", 1, { family: "info", rule: false }],
    ]);
  });

  test("a formula block on its item's first line: rendered, its marker with it", () => {
    expect(
      blocksOf("1) $$\n   x\n   $$").map(({ kind, source, list, marker }) => [
        kind,
        source.trim(),
        list,
        marker,
      ]),
    ).toEqual([["math", "x", 0, "1)"]]);
  });

  test("with the focus, a block the selection touches is its source", () => {
    const text = `${TABLE}\n\n$$\nx\n$$`;
    const inTable = [{ from: 3, to: 3 }];
    expect(blocksOf(text, inTable, true).map((b) => b.kind)).toEqual(["math"]);
    // A range from the table's last line into the formula touches both.
    const across = [{ from: TABLE.length - 1, to: text.length - 1 }];
    expect(blocksOf(text, across, true)).toEqual([]);
    // Without the focus, nothing is revealed (analysis 11a.1, point 1).
    expect(blocksOf(text, inTable, false).map((b) => b.kind)).toEqual([
      "table",
      "math",
    ]);
  });

  test("the work is one step per top-level block, whatever their length", () => {
    const doc = (words: number) =>
      Array.from(
        { length: 50 },
        (_, i) => `Paragraphe ${i} ${"mot ".repeat(words)}.`,
      ).join("\n\n");
    const work = (text: string) =>
      countDuring("live.block", () => blocksOf(text));
    expect(work(doc(10))).toBe(50);
    expect(work(doc(40))).toBe(50);
  });

  test("a block holding an annotation, active or not, stays its source; a remote caret does not keep it (decision 7)", () => {
    const text = `${TABLE}\n\n$$\nE = mc^2\n$$`;
    const inTable = text.indexOf("1");
    const inFormula = text.indexOf("mc");
    const kinds = (reveal: Reveal[]) =>
      blocksOf(text, [], false, reveal).map((block) => block.kind);
    expect(
      kinds([{ from: inTable, to: inTable + 1, kind: "annotation" }]),
    ).toEqual(["math"]);
    expect(kinds([{ from: inFormula, to: inFormula, kind: "active" }])).toEqual(
      ["table"],
    );
    expect(kinds([{ from: inTable, to: inTable, kind: "cursor" }])).toEqual([
      "table",
      "math",
    ]);
  });
});
