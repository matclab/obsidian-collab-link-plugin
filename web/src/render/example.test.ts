// @vitest-environment jsdom
// docs/example.md holds every Markdown construction the page reads (AGENTS.md
// §3): the preview renders each, and the editor's parser finds each; the
// editor draws the tables and formula blocks the preview draws (in quotes
// and lists too).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { liveBlocks } from "../editor/live-blocks.js";
import { livePreview } from "../editor/live-preview.js";
import { markdownSyntax } from "../editor/markdown-syntax.js";
import { headingForFragment } from "../outline/fragment.js";
import { outlineOfText } from "../outline/outline.js";
import { renderMarkdown, renderMarkdownBlocks } from "./index.js";

const example = readFileSync(
  join(import.meta.dirname, "../../../docs/example.md"),
  "utf8",
);

/** The family of the preview's innermost callout around `element`, if
 * any. */
const familyOf = (element: Element): string | undefined =>
  Array.from(element.closest(".md-callout")?.classList ?? [])
    .find((name) => name !== "md-callout" && name.startsWith("md-callout-"))
    ?.slice("md-callout-".length);

describe("docs/example.md", () => {
  test("the preview renders each construction", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(example);
    const count = (selector: string) => root.querySelectorAll(selector).length;
    for (const [selector, at_least] of [
      ["h1", 3],
      ["h2", 10],
      ["h3", 1],
      ["h4", 1],
      ["h5", 1],
      ["h6", 1],
      ["em", 2],
      ["strong", 2],
      ["s", 1],
      ["mark:not([class])", 2],
      ["mark.md-highlight-red", 1],
      ["mark.md-highlight-orange", 1],
      ["mark.md-highlight-yellow", 1],
      ["mark.md-highlight-green", 1],
      ["mark.md-highlight-blue", 1],
      ["mark.md-highlight-purple", 1],
      ["mark em", 1],
      ["p code", 2],
      ["br", 1],
      ['a[href^="https://"]', 2],
      ['a[href^="mailto:"]', 1],
      ['a[href="https://example.org/reference"]', 1],
      ['img[src^="data:image/png"]', 1],
      ["a.remote-image", 4],
      [".remote-image-case[data-image-source]", 1],
      ['.attached-image[data-attachment="AAECAwQFBgcICQoLDA0ODw"]', 1],
      ['.attached-image[data-attachment=""]', 1],
      ["ul ul ul li", 1],
      ["ol ol li", 1],
      ["ol ul li", 1],
      ["li.task-list-item input:checked", 2],
      ["ol > li.task-list-item input", 2],
      ["li.task-list-item input:not(:checked)", 1],
      ["blockquote blockquote", 1],
      ["blockquote ul ul", 1],
      ["hr", 3],
      ["pre code", 3],
      [".mermaid", 1],
      ["table th", 3],
      ["blockquote table", 1],
      ["li table", 2],
      ["blockquote li pre code", 1],
      ["table td .math", 1],
      ["span.math:not(.math-display)", 2],
      ["span.math-display", 1],
      ["div.math-display", 5],
      ["blockquote div.math-display", 1],
      ["li div.math-display", 2],
      [".footnotes li", 3],
      ["pre.front-matter", 1],
      [".md-callout", 6],
      [".md-callout-warning .md-callout-content li", 1],
      [".md-callout-tip .md-callout-default-title", 1],
      ["details.md-callout-warning:not([open]) > summary", 1],
      ["details.md-callout-question[open] > summary", 1],
      ["div.md-callout-tip > div.md-callout-title", 1],
      [".md-callout-question .md-callout-example blockquote", 1],
      ['.md-callout-note[data-callout="mon-type"] div.math-display', 1],
      ['.md-callout-note[data-callout="mon-type"] table', 1],
      ['.md-callout-note[data-callout="mon-type"] pre code', 1],
      ["li .md-callout-info", 1],
      ['a.md-wikilink[href^="#"]', 3],
      ['.md-wikilink-local[data-wikilink="note"]', 2],
      ['.md-wikilink-local[data-wikilink="block"]', 1],
    ] as const) {
      expect(count(selector), selector).toBeGreaterThanOrEqual(at_least);
    }
    // Every image granted (ADR-0055): only the one the page may load is,
    // without a referrer; the others stay links.
    const granted = document.createElement("div");
    granted.innerHTML = renderMarkdown(example, () => true);
    expect(
      Array.from(
        granted.querySelectorAll('img[referrerpolicy="no-referrer"]'),
        (img) => img.getAttribute("src"),
      ),
    ).toEqual(["https://example.org/carte.png"]);
    expect(granted.querySelectorAll("a.remote-image").length).toBe(3);
    // What stays text: HTML, prices, escaped dollars, CriticMarkup.
    expect(root.querySelector("span[style]")).toBeNull();
    expect(root.textContent).toContain('<span style="color:red">');
    expect(root.textContent).toContain("5 $ et 10 $");
    // Callout headers that are not on their quote's first line, as written.
    expect(root.textContent).toContain("[!note] Deux espaces");
    expect(root.textContent).toContain("[!note] Après une ligne");
    expect(root.textContent).toContain("{++ajout++}");
    // Not highlights; an emoji not a color's, shown.
    expect(root.textContent).toContain("== ainsi ==");
    expect(root.textContent).toContain("==signe échappé==");
    expect(root.textContent).not.toContain("🔴");
    expect(
      Array.from(root.querySelectorAll("mark"), (m) => m.textContent),
    ).toContain("⚫noir");
    expect(root.textContent).toContain("[!note] Deux espaces");
    expect(root.textContent).toContain("[!note] une citation ordinaire");
    // Not Obsidian links: an embed, empty brackets, code, escaped.
    expect(root.textContent).toContain("![[Image.png]]");
    expect(root.textContent).toContain("[[]]");
    expect(root.textContent).toContain("[[crochet échappé]]");
    // A link around an Obsidian link: text, but for the inner one.
    expect(root.textContent).toContain(
      "[voir Tableaux](https://example.org/autour)",
    );
    expect(
      root.querySelector('a[href="https://example.org/autour"]'),
    ).toBeNull();
    // A table under a quote's text ends the quote, one under a line with
    // a `|` follows it (phase 24): neither is that text.
    const headed = (text: string) =>
      Array.from(root.querySelectorAll("table")).find(
        (table) => table.querySelector("th")?.textContent === text,
      );
    expect(headed("Hors de")?.previousElementSibling?.tagName).toBe(
      "BLOCKQUOTE",
    );
    expect(headed("Sous")?.previousElementSibling?.textContent).toMatch(
      /la suit :$/,
    );
  });

  test("the editor's parser keeps a link around an Obsidian link as text, as the preview does", () => {
    const state = EditorState.create({
      doc: example,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, example.length, 5000);
    const from = example.indexOf(
      "[voir [[#Tableaux]]](https://example.org/autour)",
    );
    expect(from).toBeGreaterThan(0);
    const found: string[] = [];
    tree?.iterate({
      from,
      to: from + 1,
      enter: (node) => void found.push(node.name),
    });
    expect(found).not.toContain("Link");
    expect(tree?.resolveInner(from + 7, 1).name).toMatch(/^Wikilink/);
  });

  test("each in-document link leads to an element of its id or to a heading (phase 19, decision 8)", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(example);
    const ids = new Set(Array.from(root.querySelectorAll("[id]"), (e) => e.id));
    const headings = outlineOfText(example);
    const anchors = Array.from(root.querySelectorAll("a[href^='#']"), (a) =>
      decodeURIComponent((a.getAttribute("href") ?? "").slice(1)),
    ).filter((id) => !ids.has(id));
    expect(anchors.length).toBeGreaterThanOrEqual(4);
    for (const id of anchors) {
      expect(headingForFragment(headings, id), id).toBeDefined();
    }
  });

  test("the editor's parser finds each construction", () => {
    const state = EditorState.create({
      doc: example,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, example.length, 5000);
    const names = new Set<string>();
    tree?.iterate({ enter: (node) => void names.add(node.name) });
    for (const name of [
      "ATXHeading1",
      "ATXHeading6",
      "SetextHeading1",
      "SetextHeading2",
      "Emphasis",
      "StrongEmphasis",
      "Strikethrough",
      "Highlight",
      "HighlightColor",
      "InlineCode",
      "Escape",
      "HardBreak",
      "Link",
      "Wikilink",
      "WikilinkAlias",
      "Autolink",
      "LinkReference",
      "Image",
      "BulletList",
      "OrderedList",
      "Task",
      "Blockquote",
      "HorizontalRule",
      "FencedCode",
      "CodeBlock",
      "Table",
      "InlineMath",
      "DisplayMath",
      "MathBlock",
      "MathTag",
      "FrontMatter",
      "CalloutMark",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  // ADR-0057 §8: each attached image the preview leaves to the view, the
  // editor's formatting leaves to it too.
  test("the editor draws every attached image the preview draws", () => {
    const state = EditorState.create({
      doc: example,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, example.length, 5000);
    if (!tree) throw new Error("not parsed");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(example);
    const previewed = Array.from(
      root.querySelectorAll<HTMLElement>(".attached-image"),
      (slot) => slot.dataset.attachment,
    );
    const drawn = livePreview(
      tree,
      state.doc,
      [],
      [{ from: 0, to: example.length }],
    )
      .filter((spec) => spec.widget === "attached-image")
      .map((spec) => spec.source);
    expect(drawn).toEqual(previewed);
    expect(drawn.length).toBe(2);
  });

  test("the editor draws every table the preview draws", () => {
    const state = EditorState.create({
      doc: example,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, example.length, 5000);
    if (!tree) throw new Error("not parsed");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(example);
    const drawn = liveBlocks(tree, state.doc, [], false).filter(
      (block) => block.kind === "table",
    );
    // In the same callout, if any (phase 15, decision 9).
    expect(
      drawn.map((block) => [
        block.source.split("\n")[0],
        block.callout?.family,
      ]),
    ).toEqual(
      Array.from(root.querySelectorAll("table"), (table) => [
        `| ${Array.from(table.querySelectorAll("th"), (th) => th.textContent).join(" | ")} |`,
        familyOf(table),
      ]),
    );
  });

  test("the editor draws every formula block the preview draws", () => {
    const state = EditorState.create({
      doc: example,
      extensions: [markdownSyntax()],
    });
    const tree = ensureSyntaxTree(state, example.length, 5000);
    if (!tree) throw new Error("not parsed");
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(example);
    const bare = (tex: string) => tex.replace(/\s+/g, "");
    const drawn = liveBlocks(tree, state.doc, [], false)
      .filter((block) => block.kind === "math")
      .map((block) => [
        bare(
          block.tag === undefined
            ? block.source
            : `${block.source}\\tag{${block.tag}}`,
        ),
        block.callout?.family,
      ]);
    expect(drawn).toEqual(
      Array.from(
        root.querySelectorAll<HTMLElement>("div.math-display"),
        (block) => [bare(block.dataset.tex ?? ""), familyOf(block)],
      ),
    );
  });

  test("the outline lists the document's own headings, as the preview shows them (phase 16)", () => {
    const { html, lines } = renderMarkdownBlocks(example);
    const root = document.createElement("div");
    root.innerHTML = html;
    const preview = Array.from(root.children).flatMap((block, i) => {
      const level = /^H([1-6])$/.exec(block.tagName)?.[1];
      return level
        ? [
            {
              level: Number(level),
              line: lines[i]?.[0],
              text: (block.textContent ?? "").replace(/\s+/g, " ").trim(),
            },
          ]
        : [];
    });
    const outline = outlineOfText(example).map(({ level, line, text }) => ({
      level,
      line,
      text,
    }));
    expect(outline).toEqual(preview);
    const texts = outline.map((h) => h.text);
    expect(texts).toContain("Titre mis en forme, code et fermé");
    expect(texts).toContain("Titre souligné de niveau 2");
    expect(texts).not.toContain("Un titre dans une citation");
  });
});
