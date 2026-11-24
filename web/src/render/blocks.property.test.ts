// @vitest-environment jsdom
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { renderMarkdown, renderMarkdownBlocks } from "./render.js";

// Every kind of block the preview may show, alone or nested, so that each
// top-level block's source lines can be checked (phase 10, decision 7).
const BLOCKS = [
  "para",
  "two\nlines",
  "# h1",
  "## h2 ##",
  "- a\n- b",
  "1. a\n\n2. b",
  "- [ ] task",
  "> q\n> more",
  "> - nested\n>   - deep",
  "> [!note] T\n> body\n>\n> - item",
  "> [!tip]-",
  "> [!a]\n> > [!b] y\n> > z",
  "| h | i |\n|---|---|\n| c | d |",
  "```\ncode\n```",
  "```mermaid\ngraph TD\n```",
  "    indented",
  "$$\nx^2\n$$",
  "***",
  "n[^1]\n\n[^1]: f",
  "<b>raw</b>",
  "",
];

describe("renderMarkdownBlocks (property)", () => {
  test(
    "the same HTML, and for each top-level block its source lines, in order, within the text",
    () =>
      hegel.test(
        (tc) => {
          const separator = tc.draw(gs.sampledFrom(["\n\n", "\n\n\n", "\n"]));
          const source = tc
            .draw(gs.arrays(gs.sampledFrom(BLOCKS), { maxSize: 8 }))
            .join(separator);
          const { html, lines } = renderMarkdownBlocks(source);
          if (html !== renderMarkdown(source)) {
            throw new Error("not the same HTML");
          }
          const template = document.createElement("template");
          template.innerHTML = html;
          // The footnotes' section comes from no block of the source.
          const blocks = Array.from(template.content.children).filter(
            (element) =>
              !element.matches("section.footnotes, hr.footnotes-sep"),
          );
          if (blocks.length !== lines.length) {
            throw new Error(
              `${blocks.length} blocks, ${lines.length} line ranges: ${JSON.stringify(source)}`,
            );
          }
          const count = source.split("\n").length;
          let previous = 0;
          for (const [start, end] of lines) {
            if (!(previous <= start && start < end && end <= count)) {
              throw new Error(
                `lines ${start}-${end} after ${previous} of ${count}: ${JSON.stringify(source)}`,
              );
            }
            previous = end;
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
