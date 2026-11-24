// @vitest-environment jsdom
// The YAML header (docs/phase-14-plugin-obsidian.md, decision 19): a note's
// properties are part of its text (decision 11). Both parsers read the
// same header (ADR-0032: they agree): a `---` line at the very start of
// the text, up to the next `---` line, or, unclosed, to the end — the
// editor's parser can't read ahead to the closing line (as for formula
// blocks, ADR-0032 point 10), and the preview follows it. Shown as it is
// written, never formatted as Markdown.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { markdownSyntax } from "../editor/markdown-syntax.js";
import { renderMarkdown, renderMarkdownBlocks } from "./index.js";

/** The header the editor's parser finds: its text between the marks,
 * and the text after it, or none. */
function editorHeader(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [markdownSyntax()],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  const node = tree?.topNode.getChild("FrontMatter");
  if (!node) return undefined;
  const marks = node.getChildren("FrontMatterMark");
  const open = (marks[0]?.to ?? node.from) + 1;
  const close = marks[1] ? marks[1].from - 1 : node.to;
  return {
    // Trailing empty lines aside: unclosed, the editor's node ends with
    // the text, the preview's lines with its last line.
    content: text.slice(open, Math.max(open, close)).replace(/\n+$/, ""),
    after: text.slice(node.to).replace(/^\n/, ""),
  };
}

/** The header the preview renders: its text, and the text after its
 * source lines. */
function previewHeader(text: string) {
  const { html, lines } = renderMarkdownBlocks(text);
  const root = document.createElement("div");
  root.innerHTML = html;
  const first = root.firstElementChild;
  if (!first?.matches("pre.front-matter")) return undefined;
  return {
    content: (first.textContent ?? "").replace(/\n+$/, ""),
    after: text
      .split("\n")
      .slice(lines[0]?.[1] ?? 0)
      .join("\n"),
  };
}

const LINE = gs.sampledFrom([
  "---",
  "--- ",
  "title: Note",
  "tags: [a, b]",
  "# Heading",
  "- item",
  "| a | b |",
  "| - | - |",
  "> quote",
  "$$",
  "```",
  "",
  "text",
]);

describe("the YAML header", () => {
  test("both parsers find the same one, with the same text and lines", () => {
    hegel.test(
      (tc) => {
        const lines = tc.draw(gs.arrays(LINE, { minSize: 1, maxSize: 8 }));
        if (tc.draw(gs.booleans())) lines.unshift("---");
        const text = lines.join("\n");
        const editor = editorHeader(text);
        const preview = previewHeader(text);
        if (JSON.stringify(editor) !== JSON.stringify(preview)) {
          throw new Error(
            `text=${JSON.stringify(text)}\neditor=${JSON.stringify(editor)}\npreview=${JSON.stringify(preview)}`,
          );
        }
      },
      { testCases: 400 },
    );
  });

  test("is shown as written, at the very start of the text only", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(
      "---\ntags: [a]\ntitle: *x*\n---\n# Note\n",
    );
    expect(root.querySelector("pre.front-matter")?.textContent).toBe(
      "tags: [a]\ntitle: *x*",
    );
    expect(root.querySelector("hr")).toBeNull();
    expect(root.querySelector("h1")?.textContent).toBe("Note");
    expect(root.querySelector("h2")).toBeNull();

    root.innerHTML = renderMarkdown("Text\n\n---\ntags: [a]\n---\n");
    expect(root.querySelector("pre.front-matter")).toBeNull();
    root.innerHTML = renderMarkdown("> ---\n> a\n> ---\n");
    expect(root.querySelector("pre.front-matter")).toBeNull();
  });

  test("an empty one, or one not closed yet", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("---\n---\nText\n");
    expect(root.querySelector("pre.front-matter")?.textContent).toBe("");
    expect(root.querySelector("p")?.textContent).toBe("Text");
    root.innerHTML = renderMarkdown("---\ntags: [a]\n# Still in it\n");
    expect(root.querySelector("pre.front-matter")?.textContent).toBe(
      "tags: [a]\n# Still in it",
    );
  });
});
