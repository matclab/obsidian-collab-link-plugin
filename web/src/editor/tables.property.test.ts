// @vitest-environment jsdom
// The editor and the preview find the same tables, in the same blocks
// (ADR-0032): a table drawn in one and text in the other is a defect —
// on an item's or a quote's lazy lines too (phase 24).
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { markdownSyntax } from "./markdown-syntax.js";

// What a line may continue: an item, a quote, both, nested, or nothing,
// with indentations around an item's.
const PREFIXES = [
  "",
  "",
  "",
  " ",
  "  ",
  "   ",
  "- ",
  "  - ",
  "1. ",
  "> ",
  "> > ",
  "> - ",
];
const BODIES = [
  "",
  "text",
  "| a | b |",
  "a | b",
  "| a |",
  "|---|---|",
  "-|-",
  "| c | d |",
  // A table, whole: chance rarely draws its two lines in order.
  "| a | b |\n|---|---|",
];

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const ELEMENT_BY_NODE: Record<string, string> = {
  BulletList: "ul",
  OrderedList: "ol",
  ListItem: "li",
  Blockquote: "blockquote",
};

/** Each table, as the blocks around it and its number of body rows. */
type Found = string;

function editorTables(text: string): Found[] {
  const state = EditorState.create({
    doc: text,
    extensions: [markdownSyntax()],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  const found: Found[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const around: string[] = [];
      for (let up = node.node.parent; up; up = up.parent) {
        const element = ELEMENT_BY_NODE[up.name];
        if (element) around.unshift(element);
      }
      const rows = node.node.getChildren("TableRow").length;
      found.push(`${around.join(">")} ${rows}`);
    },
  });
  return found;
}

function previewTables(text: string): Found[] {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(text);
  return Array.from(root.querySelectorAll("table"), (table) => {
    const around: string[] = [];
    for (
      let up = table.parentElement;
      up && up !== root;
      up = up.parentElement
    ) {
      around.unshift(up.tagName.toLowerCase());
    }
    const rows = table.querySelectorAll("tbody tr").length;
    return `${around.join(">")} ${rows}`;
  });
}

function scenario(tc: TC): void {
  const lines = tc.draw(
    gs.arrays(gs.tuples(gs.sampledFrom(PREFIXES), gs.sampledFrom(BODIES)), {
      minSize: 1,
      maxSize: 7,
    }),
  );
  const text = lines.map(([prefix, body]) => prefix + body).join("\n");
  // An empty list item: the two parsers let it interrupt a paragraph, a
  // table's rows among them, otherwise (as for the outline's property).
  tc.assume(!/^[ >]*(?:[-+*]|\d+[.)])[ \t]*$/m.test(text));
  expect(editorTables(text), JSON.stringify(text)).toEqual(previewTables(text));
}

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`… when a case fails). A case assumed away passes, as for
 * Hegel. */
function replay(draws: readonly unknown[]): TC {
  let next = 0;
  return {
    draw: () => draws[next++],
    assume: () => {},
  } as unknown as TC;
}

describe("tables (property)", () => {
  test("the editor finds the tables the preview draws, in the same blocks", () =>
    hegel.test(scenario, { testCases: 400 }));

  // Found by the property while writing it (phase 24), kept here rather
  // than only in web/.hegel/examples: a table under a line with a `|`,
  // which the editor's parser read as one paragraph.
  test.each([
    [
      [
        ["", "| a | b |"],
        ["", "| a | b |\n|---|---|"],
      ],
    ],
  ])("a counter-example kept: %j", (lines) => scenario(replay([lines])));
});

// Found by a wider search while writing the property, each a family the
// rules above settle.
describe("where both parsers put a table", () => {
  test.each([
    // A lazy header line ends the item, the quote, the callout.
    ["- item\n| a | b |\n|---|---|", [" 0"]],
    ["> q\n| a | b |\n|---|---|", [" 0"]],
    ["> [!note] T\n| a | b |\n|---|---|", [" 0"]],
    // The outer quote keeps a table that is lazy for the inner one.
    ["> > q\n> | a | b |\n> |---|---|", ["blockquote 0"]],
    // A table's lazy lines stay in it.
    ["- item\n  | a | b |\n|---|---|\n| c | d |", ["ul>li 1"]],
    ["> a | b\n-|-\n|---|---|", ["blockquote 1"]],
    // A lazy delimiter row deeper in quotes opens a quote of its own.
    ["> q\n| a | b |\n> |---|---|", []],
    ["> text\n| a | b |\n> |---|---|\n| a | b |\n|---|---|", [" 0"]],
    // A table after a paragraph's line with a `|`.
    ["a | b\n| a | b |\n|---|---|", [" 0"]],
    // A quote's or an item's marker is not a table's cell.
    ["> a | b\n-|-", ["blockquote 0"]],
    ["1. | a |\n-|-", []],
  ])("%j", (text, expected) => {
    expect(previewTables(text)).toEqual(expected);
    expect(editorTables(text)).toEqual(expected);
  });
});
