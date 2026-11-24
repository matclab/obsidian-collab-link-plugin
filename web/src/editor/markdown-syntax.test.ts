// @vitest-environment jsdom
// The editor's Markdown (phase 11b.1): tables, strikethrough and task
// lists parsed, as the preview renders them, and the syntax highlighted
// with the page's classes, in both modes.
import { ensureSyntaxTree, forceParsing } from "@codemirror/language";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { createDocumentEditor } from "./editor.js";

function editorWith(text: string) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const editor = createDocumentEditor(document.createElement("div"), doc);
  // Parsed to the end: under load, the parser stops at its time budget.
  forceParsing(editor.view, text.length, 5000);
  return editor.view;
}

function nodeNames(text: string): string[] {
  const view = editorWith(text);
  const tree = ensureSyntaxTree(view.state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  const names: string[] = [];
  tree.iterate({ enter: (node) => void names.push(node.name) });
  return names;
}

/** The texts the editor draws with a class. */
function classed(text: string, className: string): string[] {
  const view = editorWith(text);
  return Array.from(
    view.contentDOM.querySelectorAll(`.${className}`),
    (element) => element.textContent ?? "",
  );
}

describe("the editor's Markdown", () => {
  test("parses tables, strikethrough, task lists", () => {
    const names = nodeNames(
      "~~old~~\n\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    );
    expect(names).toContain("Strikethrough");
    expect(names).toContain("Task");
    expect(names).toContain("Table");
  });

  test("a code span right after an escaped backtick, as the preview reads it (CommonMark)", () => {
    expect(classed("\\``a` b", "cm-md-code")).toEqual(["a"]);
    expect(classed("x\\``` y `` z", "cm-md-code")).toEqual([" y "]);
    // Its dollars are code, not a formula.
    expect(nodeNames("\\``\n$$$`")).not.toContain("InlineMath");
    // Closed by a run as long only.
    expect(classed("\\``a`` b", "cm-md-code")).toEqual([]);
    // A backslash itself escaped escapes nothing: one run of two.
    expect(classed("\\\\``a`", "cm-md-code")).toEqual([]);
  });

  test("an autolink without brackets stays text, as in the preview", () => {
    // markdown-it's `linkify` is off in render/ (ADR-0021).
    expect(nodeNames("see www.example.org now")).not.toContain("URL");
  });

  test("highlights headings, emphasis, code and links", () => {
    const text =
      "# Title\n\nSome **bold**, *it*, ~~old~~, `code` and [a link](https://x.org).";
    // A style covers its own marks, which are also drawn as markup.
    const joined = (className: string) => classed(text, className).join("|");
    expect(joined("cm-md-heading")).toBe("#| Title");
    expect(joined("cm-md-strong")).toBe("**|bold|**");
    expect(joined("cm-md-em")).toBe("*|it|*");
    expect(joined("cm-md-strike")).toBe("~~|old|~~");
    expect(joined("cm-md-code")).toBe("code");
    expect(classed(text, "cm-md-link")).toContain("a link");
    expect(classed(text, "cm-md-url")).toEqual(["https://x.org"]);
  });

  // ADR-0044: Obsidian's highlights, as the preview reads them.
  test("parses a highlight, its marks and a color's emoji right after the opening", () => {
    const names = nodeNames("a ==🔴b *c*== d");
    expect(names).toContain("Highlight");
    expect(names.filter((name) => name === "HighlightMark")).toHaveLength(2);
    expect(names).toContain("HighlightColor");
    expect(nodeNames("==⚫b==")).not.toContain("HighlightColor");
    expect(nodeNames("== b ==")).not.toContain("Highlight");
    expect(nodeNames("`==b==`")).not.toContain("Highlight");
    const text = "x ==hi== y";
    expect(classed(text, "cm-md-highlight").join("|")).toBe("==|hi|==");
    expect(classed(text, "cm-md-markup")).toEqual(["==", "=="]);
  });

  // A run of `=` read whole, as markdown-it-mark reads it (« Défauts
  // connus », 2026-10-23): judged on what is around the run, an odd `=`
  // text, before the pairs or after a pair that closes; never a pair with
  // another of its run.
  test("a run of `=` is read whole, as the preview reads it", () => {
    expect(nodeNames("p a===🔴==")).not.toContain("Highlight");
    expect(nodeNames("p a====b")).not.toContain("Highlight");
    expect(classed("p ===a== b", "cm-md-highlight").join("|")).toBe("==|a|==");
    expect(classed("p ==a=== b", "cm-md-highlight").join("|")).toBe("==|a|==");
    expect(classed("p ==a==== b", "cm-md-highlight").join("|")).toBe("==|a|==");
  });

  test("the markup is drawn apart from the text", () => {
    const marks = classed("# T\n\n**b** `c`", "cm-md-markup");
    expect(marks).toEqual(["#", "**", "**", "`", "`"]);
  });

  test("finds formulas as the preview does, drawn as code until rendered", () => {
    expect(nodeNames("Prix : 5 $ et 10 $.")).not.toContain("InlineMath");
    const names = nodeNames("Soit $x^2$.\n\n$$\nE = mc^2\n$$");
    expect(names).toContain("InlineMath");
    expect(names).toContain("MathBlock");
    expect(classed("Soit $x^2$.", "cm-md-code")).toContain("x^2");
    expect(classed("Soit $x^2$.", "cm-md-markup")).toEqual(["$", "$"]);
  });

  test("a callout's header: `[!` and `]` with its fold sign marked, its type text, never a link", () => {
    const marks = (text: string) => {
      const view = editorWith(text);
      const tree = ensureSyntaxTree(view.state, text.length, 5000);
      const found: string[] = [];
      tree?.iterate({
        enter: (node) => {
          if (node.name === "CalloutMark")
            found.push(text.slice(node.from, node.to));
        },
      });
      return found;
    };
    expect(marks("> [!warning]- Titre\n> body")).toEqual(["[!", "]-"]);
    expect(marks(">[!note]")).toEqual(["[!", "]"]);
    expect(nodeNames("> [!note] T")).not.toContain("Link");
    // Its type is text, parsed as such: as in the preview, outside a quote.
    expect(nodeNames("[!*a*] x")).toContain("Emphasis");
    // At a paragraph's start only, and in a header's shape only.
    expect(marks("> x [!note] y")).toEqual([]);
    expect(marks("> x\n> [!note] y")).toEqual([]);
    for (const text of [
      "> [!note](https://u.org)",
      "> [!tip]-Collé",
      "> [!info]x",
      "> [!]",
      "> \\[!note]",
      "> `[!note]`",
    ]) {
      expect(marks(text), text).toEqual([]);
    }
    expect(nodeNames("> [!note](https://u.org)")).toContain("Link");
    // Drawn as markup.
    expect(classed("> [!tip]+ T", "cm-md-markup")).toEqual(
      expect.arrayContaining(["[!", "]+"]),
    );
  });
});
