// Formulas in the editor's parser (phase 11, decision 2): `$…$` and
// `$$…$$` inline, `$$` at a line's start for a block — by the "dollars"
// rules of markdown-it-texmath, which the preview applies (Pandoc's:
// `5 $ et 10 $` stays text).

import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { formulas, mathExtension } from "./math-syntax.js";

function formulasOf(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [markdown({ extensions: [mathExtension] })],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  return formulas(tree, state.doc);
}

describe("mathExtension", () => {
  test("inline formulas, single and double dollars", () => {
    expect(formulasOf("Soit $x^2$ et $$\\sum_i i$$ ici.")).toEqual([
      { kind: "inline", tex: "x^2" },
      { kind: "display", tex: "\\sum_i i" },
    ]);
  });

  test("prices and other lone dollars stay text", () => {
    for (const text of [
      "5 $ et 10 $",
      "Coût : 5$, puis $ 3",
      "\\$a$",
      "1$b$",
      "$a$1",
      "$ a$",
      "$a $",
      "$$",
    ]) {
      expect(formulasOf(text), text).toEqual([]);
    }
    // As the preview reads it: a one-character formula, `$`.
    expect(formulasOf("$$$$")).toEqual([{ kind: "inline", tex: "$" }]);
  });

  test("a formula's content is not Markdown", () => {
    expect(formulasOf("$a*b*c$ et $`x`$")).toEqual([
      { kind: "inline", tex: "a*b*c" },
      { kind: "inline", tex: "`x`" },
    ]);
  });

  test("a code span keeps its dollars", () => {
    expect(formulasOf("`$a$` et $b$")).toEqual([{ kind: "inline", tex: "b" }]);
  });

  test("a block: `$$` at a line's start, over lines, with or without a number", () => {
    expect(formulasOf("$$\nE = mc^2\n$$\n\n$$a$$ (1)\n\nfin")).toEqual([
      { kind: "block", tex: "\nE = mc^2\n" },
      { kind: "block", tex: "a", tag: "1" },
    ]);
  });

  test("a block does not interrupt a paragraph: there, it is inline", () => {
    expect(formulasOf("texte\n$$\nx\n$$")).toEqual([
      { kind: "display", tex: "\nx\n" },
    ]);
  });

  test("an unclosed block is text", () => {
    expect(formulasOf("$$\nx\n\ny")).toEqual([]);
  });

  test("as the preview reads a block: its number on the next line, a `(` in it, a `$` ending it", () => {
    expect(formulasOf("$$\nx\n$$\n(1)\n\nfin")).toEqual([
      { kind: "block", tex: "\nx\n", tag: "1" },
    ]);
    expect(formulasOf("$$ $$((1)")).toEqual([
      { kind: "block", tex: " ", tag: "(1" },
    ]);
    expect(formulasOf("$$\n$$$(1)")).toEqual([
      { kind: "block", tex: "\n$", tag: "1" },
    ]);
    // `$$$` closing a line, its number on the next: the numbered rule's
    // close, one `$` further (found by the differential property).
    expect(formulasOf("$$\nx\n$$$\n(1)\n")).toEqual([
      { kind: "block", tex: "\nx\n$", tag: "1" },
    ]);
    // Without a number, the plain rule's.
    expect(formulasOf("$$\nx\n$$$\n\nfin")).toEqual([
      { kind: "block", tex: "\nx\n" },
    ]);
  });

  test("a block in a quote or a list: its marks where they are in the text", () => {
    for (const text of ["> $$\n> x\n> $$", "- $$\n  x\n  $$"]) {
      const state = EditorState.create({
        doc: text,
        extensions: [markdown({ extensions: [mathExtension] })],
      });
      const tree = ensureSyntaxTree(state, text.length, 5000);
      const marks: number[] = [];
      tree?.iterate({
        enter: (node) => {
          if (node.name === "MathMark") marks.push(node.from);
        },
      });
      expect(marks, text).toEqual([text.indexOf("$$"), text.lastIndexOf("$$")]);
    }
  });
});
