// @vitest-environment jsdom
// The outline agrees with the preview (docs/phase-16-plan-du-document.md,
// decision 5; AGENTS.md §3): on generated texts, the document's own
// headings the editor's parser finds are the preview's top-level ones —
// level, line and text shown.

import { Text } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { renderMarkdownBlocks } from "../render/index.js";
import { outlineOf, parseWhole } from "./outline.js";

// Inline Markdown both parsers read (as live-preview.property.test.ts),
// and formulas.
const INLINE = [
  "a",
  "bc",
  " ",
  "*",
  "**",
  "_",
  "~~",
  "`",
  "` a `",
  "\\",
  "\\*",
  "#",
  " #",
  "##",
  "[t](https://u.org)",
  "<https://y.org>",
  "![a](https://u.org/i.png)",
  "![b](data:image/png;base64,AAAA)",
  "$x$",
  "$$y$$",
];

// What a line may start with: headings and what is not one, the blocks a
// heading may hide in, Setext underlines, code, HTML, tables.
const LINE_STARTS = [
  "",
  "",
  "# ",
  "## ",
  "###### ",
  "####### ",
  "#",
  "   # ",
  "    # ",
  "> ",
  "> # ",
  "> [!note] ",
  "- ",
  "- # ",
  "1. ## ",
  "  ",
  "===",
  "---",
  "-",
  "```",
  "~~~",
  "<div>",
  "|a|b|",
  "|-|-|",
  "$$",
];

interface Seen {
  level: number;
  line: number;
  text: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function editorHeadings(text: string): Seen[] {
  const doc = Text.of(text.split("\n"));
  return outlineOf(parseWhole(doc), doc).map(({ level, line, text }) => ({
    level,
    line,
    text,
  }));
}

/** The preview's top-level headings: each top-level element, its source
 * lines from the same parse. */
function previewHeadings(text: string): Seen[] {
  const { html, lines } = renderMarkdownBlocks(text);
  const div = document.createElement("div");
  div.innerHTML = html;
  const blocks = Array.from(div.children);
  if (blocks.length !== lines.length) {
    throw new Error(`${blocks.length} blocks, ${lines.length} line ranges`);
  }
  const seen: Seen[] = [];
  blocks.forEach((block, i) => {
    const level = /^H([1-6])$/.exec(block.tagName)?.[1];
    if (!level) return;
    seen.push({
      level: Number(level),
      line: lines[i]?.[0] ?? -1,
      text: oneLine(block.textContent ?? ""),
    });
  });
  return seen;
}

describe("the outline (properties)", () => {
  test(
    "its headings are the preview's top-level headings",
    () =>
      hegel.test(
        (tc) => {
          const text = tc
            .draw(
              gs.arrays(
                gs.tuples(
                  gs.sampledFrom(LINE_STARTS),
                  gs.arrays(gs.sampledFrom(INLINE), { maxSize: 5 }),
                ),
                { minSize: 1, maxSize: 8 },
              ),
            )
            .map(([start, words]) => `${start}${words.join("")}`)
            .join("\n");
          // The known divergences of the live preview's property, for the
          // same reasons: an escaped backtick before a code span, runs of
          // three tildes or more.
          tc.assume(!text.includes("\\`") && !text.includes("~~~"));
          // An HTML block: the editor's parser reads one (as Obsidian),
          // markdown-it without HTML a paragraph, and what follows it on
          // the next lines is a heading only to the preview.
          tc.assume(!/^ {0,3}</m.test(text));
          // A formula block: the editor reads it as a paragraph, a line of
          // it may open a heading there (ADR-0032 point 10).
          tc.assume(!/^[ >\-+*\d.]*\$\$/m.test(text));
          // An empty list item: the two parsers end it, or let it
          // interrupt a paragraph, otherwise (a blank line after it, CommonMark's
          // example 280; under a quote's paragraph, which it may not
          // interrupt), and an indented heading after it is the
          // document's to one of them only.
          tc.assume(!/^[ >]*(?:[-+*]|\d+[.)])[ \t]*$/m.test(text));
          const editor = editorHeadings(text);
          const preview = previewHeadings(text);
          if (JSON.stringify(editor) !== JSON.stringify(preview)) {
            throw new Error(
              `text=${JSON.stringify(text)}\neditor=${JSON.stringify(editor)}\npreview=${JSON.stringify(preview)}`,
            );
          }
        },
        { testCases: 500 },
      ),
    120_000,
  );
});
