// @vitest-environment jsdom
// The editor and the preview find the same formulas (phase 11, decision
// 2): a formula shown in one and not the other is a defect.

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { formulas } from "./math-syntax.js";

// What makes dollars ambiguous: digits, backslashes, spaces, code, and
// the Markdown around them.
const PIECES = [
  "$",
  "$$",
  "$$",
  "a",
  "x^2",
  "b c",
  " ",
  "\\",
  "\\$",
  "1",
  "`",
  "*",
  "(1)",
  "(",
  ")",
  ".",
];
// Whole blocks too, as one gesture: a block closed alone on its line and
// numbered on the next is three precise lines, which chance almost never
// draws.
const LINE_STARTS = [
  "",
  "",
  "",
  "$$",
  "$$ ",
  "- ",
  "# ",
  "> ",
  "> $$",
  "(1)",
  "$$\nx\n$$",
  "$$\nx\n$$\n(1)",
];

type Found = { kind: string; tex: string };

function editorFormulas(text: string): Found[] {
  const state = EditorState.create({
    doc: text,
    // The editor's own parser, all its extensions.
    extensions: [markdownSyntax()],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  return formulas(tree, state.doc).map(({ kind, tex, tag }) => ({
    // The preview writes a block's number into its source.
    kind,
    tex: tag === undefined ? tex : `${tex}\\tag{${tag}}`,
  }));
}

function previewFormulas(text: string): Found[] {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(text);
  return Array.from(div.querySelectorAll<HTMLElement>(".math"), (element) => ({
    kind:
      element.tagName === "DIV"
        ? "block"
        : element.classList.contains("math-display")
          ? "display"
          : "inline",
    tex: element.dataset.tex ?? "",
  }));
}

/** The divergences accepted on 2026-10-09 (a block formula read like a
 * paragraph), seen in the source: after a `$$` that opens a line (quote
 * markers aside), up to the next `$`, a blank line, or a line that starts
 * a construct able to interrupt a paragraph (a quote among them: a change
 * of quote depth). */
function acceptedDivergence(text: string): boolean {
  const lines = text.split("\n");
  const bare = (line: string) => line.replace(/^[ \t]*(>[ \t]*)*/, "");
  const depth = (line: string) =>
    (/^[ \t]*(>[ \t]*)*/.exec(line)?.[0].match(/>/g) ?? []).length;
  for (let i = 0; i < lines.length; i++) {
    // A list item's markers aside too, for the opening: a nested list's
    // as well (`- * $$`).
    const opening = bare(lines[i] ?? "").replace(
      /^(([-+*]|\d+[.)])[ \t]+)+/,
      "",
    );
    if (!opening.startsWith("$$") || opening.indexOf("$", 2) >= 0) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = bare(lines[j] ?? "");
      if (
        line === "" ||
        /^([-+*#]|\d+[.)]|```|~~~)/.test(line) ||
        depth(lines[j] ?? "") !== depth(lines[i] ?? "")
      )
        return true;
      if (line.includes("$")) {
        // Its number may come after a blank line, too.
        const next = bare(lines[j + 1] ?? "");
        if (next === "" && /^\s*\(/.test(bare(lines[j + 2] ?? ""))) return true;
        break;
      }
    }
  }
  return /\$\$[ \t]*\n([ \t>]*\n)+[ \t>]*\(/.test(text);
}

/** Block structure, not formulas: markdown-it ends a paragraph (a quote's
 * too) at an empty list item, bulleted or ordered; CommonMark (the
 * editor's parser) keeps it as a lazy line of that paragraph. */
function emptyListItem(text: string): boolean {
  return /^([-+*]|\d+[.)])[ \t]*$/m.test(text);
}

describe("the accepted divergences", () => {
  test("an empty ordered item after a paragraph (found by the property, 2026-11-08)", () => {
    // The preview ends the item's paragraph at `1)` and reads a block
    // formula; the editor keeps `1)` in it, and reads a display one.
    const text = "- $\n1)\n$$\nx\n$$$\n";
    expect(previewFormulas(text)).toEqual([{ kind: "block", tex: "\nx\n" }]);
    expect(editorFormulas(text)).toEqual([{ kind: "display", tex: "\nx\n" }]);
    expect(emptyListItem(text)).toBe(true);
  });

  test("a block opened in a nested list, a heading in it (found by the property)", () => {
    // The preview reads one formula over the heading, the editor a
    // heading: ADR-0032, point 10. Two list markers before the `$$`.
    const text = "- * $$\n# $$\n";
    expect(previewFormulas(text)).toHaveLength(1);
    expect(editorFormulas(text)).toHaveLength(0);
    expect(acceptedDivergence(text)).toBe(true);
  });
});

describe("formulas (property)", () => {
  test(
    "the editor finds the formulas the preview shows, and no others",
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
              { minSize: 1, maxSize: 5 },
            ),
          );
          const text = lines
            .map(([start, pieces, end]) => `${start}${pieces.join("")}${end}`)
            .join("");
          tc.assume(!emptyListItem(text));
          tc.assume(!acceptedDivergence(text));
          const preview = previewFormulas(text);
          const editor = editorFormulas(text);
          // Whitespace and a quote's `>` aside: markdown-it strips a
          // continuation line's indentation and a quoted formula's markers
          // (with the line break before them), the editor reads the text
          // as it is. Kinds, number and order are compared exactly, the
          // formulas' other characters too; TeX ignores the spaces.
          const same = (found: Found[]) =>
            JSON.stringify(
              found.map(({ kind, tex }) => [
                kind,
                tex
                  .split("\n")
                  .map((line) => line.replace(/^[ \t]*(>[ \t]*)*/, ""))
                  .join("")
                  .replace(/\s+/g, ""),
              ]),
            );

          if (same(editor) !== same(preview)) {
            throw new Error(
              `text=${JSON.stringify(text)}\neditor=${JSON.stringify(editor)}\npreview=${JSON.stringify(preview)}`,
            );
          }
        },
        { testCases: 500 },
      ),
    60_000,
  );
});
