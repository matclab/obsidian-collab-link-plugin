// The editor and the preview take the same footnotes (phase 20, decision
// 8): a reference that leads somewhere in one and not the other, or to
// another note, is a defect.

import { Text } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { parseWhole } from "../outline/outline.js";
import { renderMarkdown } from "../render/index.js";
import { footnoteJump, footnoteLabels } from "./footnote-jump.js";

// Labels that match, differ by case, hold a space; what borders them;
// the preview's `[[…]]`.
// Inline notes, `^[…]`, are numbered among the others by the preview and
// have no other end: left to the examples.
const PIECES = [
  "[^1]",
  "[^1]",
  "[^a]",
  "[^A]",
  "[^a b]",
  "[^]",
  "a",
  " ",
  ":",
  "`",
  // Code around a reference, as one gesture: chance rarely draws it
  // where the editor's parser reads a link's address.
  "`[^1]`",
  "[[^1]]",
  "(u)",
  "[",
  "]",
  "\\",
];
const LINE_STARTS = [
  "",
  "",
  "",
  "[^1]: ",
  "[^a]: ",
  "[^1]:",
  " [^a]: ",
  "> ",
  "> [^1]: ",
  "- ",
  "- [^a]: ",
  "1. [^1]: ",
  "    ",
  "    [^1]: ",
  "    [^1]: ",
  // A link's definition, its address left for the next line.
  "[^a b]:",
  "# ",
];

/** Its code spans closed on the line: no backtick left, unescaped, once
 * they are taken out. */
function closesItsCode(line: string): boolean {
  const rest = line.replace(/(?<![`\\])(`+)([^`]|[^`].*?[^`])\1(?!`)/g, "");
  return !/(?<!\\)`/.test(rest);
}

const CITED = "[^1] [^a] [^A]";

/** For each reference that leads to a definition, the number the
 * preview gives it: its definition's, in the order of first reference;
 * sorted, as the preview shows the notes' own references after the
 * text. */
function editorNumbers(text: string): number[] {
  const doc = Text.of(text.split("\n"));
  const tree = parseWhole(doc);
  const numbers = new Map<number, number>();
  const out: number[] = [];
  for (const label of footnoteLabels(tree, doc)) {
    if (label.definition) continue;
    const to = footnoteJump(tree, doc, label.from + 1);
    if (to === null) continue;
    const number = numbers.get(to) ?? numbers.size + 1;
    numbers.set(to, number);
    out.push(number);
  }
  return out.sort((a, b) => a - b);
}

function previewNumbers(text: string): number[] {
  return Array.from(
    renderMarkdown(text).matchAll(/<a href="#fn-md-(\d+)" id="fnref-md-/g),
    (match) => Number(match[1]),
  ).sort((a, b) => a - b);
}

/** Accepted divergence (the user's, 2026-11-08): a note's definition
 * with no text, then a link's definition whose address is on the next
 * line. The preview ends the note at its line and takes what follows for
 * that address; the editor's parser reads one paragraph, a reference in
 * it. */
const EMPTY_NOTE_THEN_LINK = /\]:[ \t]*\n[ \t>]*\[[^\]\n]*\]:[ \t]*$/m;

/** Accepted divergence (ADR-0046 §8): in a list item, a definition's
 * indent counts from the item's text, not from the margin — at the head
 * of a line, or after its label (`1. [^1]:    [^1]`: code for the
 * preview, found by the property on 2026-11-08). */
const LIST_INDENT = /^ {4,}\[\^|\]:(?: {4,}|\t)/m;
const LIST_ITEM = /^[ \t>]*([-*+]|\d+[.)])/m;

describe("the accepted divergences", () => {
  test("a note's text after four spaces, in a list item (found by the property)", () => {
    const text = "1. [^1]:    [^1]\n\n\n[^1] [^a] [^A]\n";
    expect(previewNumbers(text)).toEqual([1]);
    expect(editorNumbers(text)).toEqual([1, 1]);
    expect(LIST_INDENT.test(text) && LIST_ITEM.test(text)).toBe(true);
  });

  test("a link's address under an empty note's definition (found by the property)", () => {
    const text = "[^1]: \n[^a b]:\n[^1]\n\n\n[^1] [^a] [^A]\n";
    expect(previewNumbers(text)).toEqual([1]);
    expect(editorNumbers(text)).toEqual([1, 1]);
    expect(EMPTY_NOTE_THEN_LINK.test(text)).toBe(true);
  });
});

// Found by the property on 2026-11-18 (phase 34h), outside its phase;
// corrected on 2026-11-19 (docs/defauts-corriges.md). Unlike the accepted
// divergence above, the note's definition has text: its paragraph stays
// open, and a link's definition cannot interrupt it.
describe("a link's definition under a note's text", () => {
  test("is the note's text, its address a reference (found by the property)", () => {
    const text = "[^1]: [^1]\n[^a b]:\n[^1]\n\n\n[^1] [^a] [^A]\n";
    expect(previewNumbers(text)).toEqual([1, 1, 1]);
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });

  test("and the next one too, until a blank line", () => {
    const text =
      "[^1]: x\n[a b]:\n[^1]\n[c d]:\n[^1]\n\n[e f]:\n[^1]\n\n[^1]\n";
    expect(previewNumbers(text)).toEqual([1, 1, 1]);
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });
});

// Found by the property on 2026-11-19 (phase 34j), outside its phase. A
// reference link's label defined as a link's: the preview reads a link,
// its text no reference.
describe("a reference link to a link's definition", () => {
  test("is a link, its text no reference (found by the property)", () => {
    const text = "[^1]: [^1][^a b]\n\n[^a b]:\n[^1]\n\n\n[^1] [^a] [^A]\n";
    expect(previewNumbers(text)).toEqual([1]);
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });

  test("its label matched as the preview does: case and spaces aside", () => {
    const text = "x [^1][A  b] y\n\n[a b]: u\n\n[^1]: n\n";
    expect(previewNumbers(text)).toEqual([]);
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });

  test("a label not defined: the text is a reference", () => {
    const text = "x [^1][a b] y\n\n[^1]: n\n";
    expect(previewNumbers(text)).toEqual([1]);
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });

  test("a label whose definition is a note's text: a reference", () => {
    const text = "x [^1][a b] y\n\n[^1]: n\n[a b]:\nu\n";
    expect(editorNumbers(text)).toEqual(previewNumbers(text));
  });
});

describe("footnotes (property)", () => {
  test(
    "a reference leads, in the editor, to the note the preview links it to",
    () =>
      hegel.test(
        (tc) => {
          const lines = tc.draw(
            gs.arrays(
              gs.tuples(
                gs.sampledFrom(LINE_STARTS),
                gs.arrays(gs.sampledFrom(PIECES), { maxSize: 6 }),
                gs.sampledFrom(["\n", "\n", "\n\n"]),
              ),
              { minSize: 1, maxSize: 6 },
            ),
          );
          // Every label cited at the end: the preview draws only the notes
          // something cites, references in their text with them.
          const text = `${lines
            .map(([start, pieces, end]) => `${start}${pieces.join("")}${end}`)
            .join("")}\n\n${CITED}\n`;
          // Accepted divergence: the preview opens a note on a line that
          // continues a code span of the line before, which the editor's
          // parser keeps open. The accepted divergences: ADR-0046 §8.
          tc.assume(text.split("\n").every(closesItsCode));
          // Accepted divergence: a line that continues a quote without its
          // `>`, which the two parsers end or continue differently when a
          // note's definition is on either line.
          tc.assume(!/^[ \t]*>.*\n[ \t]*[^\s>]/m.test(text));
          // Accepted divergence: a note's text continued by lines indented
          // by four spaces, a code block for the editor's parser after
          // what it reads as a link's definition.
          tc.assume(!/\]:[\s\S]*\n(?: {4}|\t).*\[\^/.test(text));
          // Accepted divergence: a link's definition with its address on
          // its line, `[a b]: u` or `[^]: u`, which the editor's parser may read as
          // the address of a definition above, or a note's text.
          tc.assume(!/\[(?!\^[^ \n\]]+\])[^\]\n]*\]:[ \t]*\S/.test(text));
          tc.assume(!EMPTY_NOTE_THEN_LINK.test(text));
          // Accepted divergence: in a list item, a definition's indent
          // counts from the item's text, not from the margin.
          // A note's text after four spaces too, on its line.
          tc.assume(!(LIST_INDENT.test(text) && LIST_ITEM.test(text)));
          // A label defined twice: the preview drops all but the last
          // definition, references in them too (left to the examples).
          const doc = Text.of(text.split("\n"));
          const defined = footnoteLabels(parseWhole(doc), doc)
            .filter((it) => it.definition)
            .map((it) => it.label);
          tc.assume(new Set(defined).size === defined.length);
          const editor = editorNumbers(text);
          const preview = previewNumbers(text);
          if (JSON.stringify(editor) !== JSON.stringify(preview)) {
            throw new Error(
              `${JSON.stringify(text)}: editor ${JSON.stringify(editor)}, preview ${JSON.stringify(preview)}`,
            );
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
