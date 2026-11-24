import {
  commonmarkLanguage,
  markdownKeymap,
  pasteURLAsLink,
} from "@codemirror/lang-markdown";
import {
  Language,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tagHighlighter, tags } from "@lezer/highlight";
import {
  type BlockContext,
  type MarkdownConfig,
  type MarkdownParser,
  Strikethrough,
  Table,
  TaskList,
} from "@lezer/markdown";
import {
  HIGHLIGHT_COLORS,
  calloutHeader,
  calloutShape,
} from "../render/index.js";
import { highlightExtension, highlightTag } from "./highlight-syntax.js";
import { mathExtension } from "./math-syntax.js";
import { wikilinkExtension, wikilinkTag } from "./wikilink-syntax.js";

/** Stable class names for the Markdown tokens, styled by the theme below
 * (a `HighlightStyle` would generate them). */
const highlighter = tagHighlighter([
  { tag: tags.heading, class: "cm-md-heading" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-em" },
  { tag: tags.strikethrough, class: "cm-md-strike" },
  { tag: highlightTag, class: "cm-md-highlight" },
  { tag: wikilinkTag, class: "cm-md-link" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.meta, class: "cm-md-meta" },
  {
    tag: [tags.processingInstruction, tags.contentSeparator],
    class: "cm-md-markup",
  },
]);

/** Inside the editor: page rules lose to CodeMirror's base theme. Colors
 * from the page's tokens, so both themes follow. */
const theme = EditorView.theme({
  ".cm-md-heading": { fontWeight: "700" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through" },
  // A highlight's tint (ADR-0044): its color's, which live formatting
  // marks it with (on its text, inside or around this class), else the
  // default.
  ".cm-md-highlight": {
    background: "var(--md-highlight-now, var(--md-highlight))",
    borderRadius: "2px",
  },
  ...Object.fromEntries(
    Object.values(HIGHLIGHT_COLORS).map((color) => [
      `.cm-md-highlight-${color}`,
      {
        "--md-highlight-now": `var(--md-highlight-${color})`,
        background: `var(--md-highlight-${color})`,
      },
    ]),
  ),
  ".cm-md-code": {
    fontFamily: "var(--font-code)",
    fontSize: "0.9em",
    background: "var(--code-bg)",
    borderRadius: "var(--radius-s)",
  },
  ".cm-md-link": { color: "var(--pencil)" },
  ".cm-md-url": { color: "var(--muted)" },
  ".cm-md-quote": { color: "var(--muted)" },
  ".cm-md-markup": { color: "var(--muted)" },
  // The YAML header: as written, set apart (decision 19).
  ".cm-md-meta": {
    fontFamily: "var(--font-code)",
    fontSize: "0.9em",
    color: "var(--muted)",
  },
});

const BACKTICK = 96;
const BACKSLASH = 92;

/** A code span opened right after an escaped backtick (`` \``a` ``):
 * @lezer/markdown refuses to open one after any backtick, where CommonMark
 * (and the preview) only refuse after a run of them — an escaped one is
 * not in the run. Same span otherwise: closed by a run as long. */
const codeAfterEscape: MarkdownConfig = {
  parseInline: [
    {
      name: "CodeAfterEscapedBacktick",
      before: "InlineCode",
      parse(cx, next, start) {
        if (next !== BACKTICK || start - 2 < cx.offset) return -1;
        if (cx.char(start - 1) !== BACKTICK) return -1;
        // Escaped: after an odd number of backslashes.
        let slashes = 0;
        for (let at = start - 2; at >= cx.offset; at--) {
          if (cx.char(at) !== BACKSLASH) break;
          slashes++;
        }
        if (slashes % 2 === 0) return -1;
        let open = start;
        while (open < cx.end && cx.char(open) === BACKTICK) open++;
        const size = open - start;
        for (let at = open; at < cx.end; ) {
          if (cx.char(at) !== BACKTICK) {
            at++;
            continue;
          }
          const run = at;
          while (at < cx.end && cx.char(at) === BACKTICK) at++;
          if (at - run === size)
            return cx.addElement(
              cx.elt("InlineCode", start, at, [
                cx.elt("CodeMark", start, open),
                cx.elt("CodeMark", run, at),
              ]),
            );
        }
        return -1;
      },
    },
  ],
};

const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const BANG = 33;
const PLUS = 43;
const MINUS = 45;

/** A callout's header: at a paragraph's start, in
 * a header's shape (`render/callout.ts`), its `[!` and its `]` with the
 * fold sign are `CalloutMark`s, so that `[!type]` is never a link. Its
 * type stays text, parsed as such: outside a quote, where it is no
 * callout, the preview shows it as text too. Whether it opens a callout
 * (first paragraph of a quote, at most one space after `>`) is for
 * `live-preview.ts`, which sees the line: the parser sees the paragraph's
 * text only. */
const calloutMarks: MarkdownConfig = {
  defineNodes: [{ name: "CalloutMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "CalloutOpen",
      before: "Link",
      parse(cx, next, start) {
        if (next !== OPEN_BRACKET || start !== cx.offset) return -1;
        if (calloutShape(cx.slice(start, cx.end)) < 0) return -1;
        return cx.addElement(cx.elt("CalloutMark", start, start + 2));
      },
    },
    {
      name: "CalloutClose",
      before: "LinkEnd",
      parse(cx, next, start) {
        if (next !== CLOSE_BRACKET || start <= cx.offset) return -1;
        // Cheap first: the paragraph opens with `[!`.
        if (
          cx.char(cx.offset) !== OPEN_BRACKET ||
          cx.char(cx.offset + 1) !== BANG
        )
          return -1;
        const close = calloutShape(cx.slice(cx.offset, cx.end));
        if (cx.offset + close !== start) return -1;
        const sign = cx.char(start + 1);
        const end = sign === PLUS || sign === MINUS ? start + 2 : start + 1;
        return cx.addElement(cx.elt("CalloutMark", start, end));
      },
    },
  ],
};

const GREATER = 62;

/** The lines a quote opens on, as written, in each parse under way. */
const quoteLines = new WeakMap<BlockContext, Map<number, string>>();

/** A callout's title is its header's line: the
 * preview reads it apart from the rest of the paragraph, before inline
 * parsing (`render.ts`), and so does this parser — a link or an emphasis
 * never spans the title's end, and what follows is read on its own. A
 * callout as `calloutOf` (callout-node.ts) sees one: a paragraph on its
 * quote's own first line, in a header's shape, at most one space after
 * `>`. Still one `Paragraph`: the title split off its inline content
 * only. */
const calloutTitle: MarkdownConfig = {
  parseBlock: [
    {
      // Watches a quote open, handles nothing: a parser sees where its
      // block starts, never the quote it is in.
      name: "QuoteOpens",
      before: "Blockquote",
      parse(cx, line) {
        // Only a line that may hold a header is kept.
        if (line.next !== GREATER || !line.text.includes("[!")) return false;
        const lines = quoteLines.get(cx) ?? new Map<number, string>();
        quoteLines.set(cx, lines);
        lines.set(cx.lineStart, line.text);
        return false;
      },
    },
    {
      name: "CalloutTitle",
      leaf(cx, leaf) {
        if (!leaf.content.startsWith("[!")) return null;
        const line = quoteLines.get(cx)?.get(cx.lineStart);
        if (
          line === undefined ||
          cx.parentType().name !== "Blockquote" ||
          !calloutHeader(line, leaf.start - cx.lineStart)
        )
          return null;
        return {
          nextLine: () => false,
          finish(cx, leaf) {
            const end = leaf.content.indexOf("\n");
            if (end < 0) return false;
            // The content keeps the text's positions: the quote's markers
            // on the next lines are spaces in it.
            const inline = [
              ...cx.parser.parseInline(leaf.content.slice(0, end), leaf.start),
              ...cx.parser.parseInline(
                leaf.content.slice(end + 1),
                leaf.start + end + 1,
              ),
            ];
            cx.addLeafElement(
              leaf,
              cx.elt(
                "Paragraph",
                leaf.start,
                leaf.start + leaf.content.length,
                inline,
              ),
            );
            return true;
          },
        };
      },
    },
  ],
};

/** A note's YAML header: a `---` line at the very
 * start of the text, up to the next `---` line — or, not closed yet, to
 * the end: the parser can't read ahead to the closing line (as for
 * formula blocks, ADR-0032 point 10), and the preview reads it the same
 * (`render.ts`). Its lines are not Markdown; it ends where it closes, so
 * an edit that closes or opens it is inside it, and parsed again. */
const frontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true, style: tags.meta },
    { name: "FrontMatterMark", style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "HorizontalRule",
      parse(cx, line) {
        // The text's own first line: a quote's or a list's has its marker.
        if (cx.lineStart !== 0 || line.text !== "---") {
          return false;
        }
        const marks = [cx.elt("FrontMatterMark", 0, 3)];
        while (cx.nextLine()) {
          if (line.text === "---") {
            marks.push(
              cx.elt("FrontMatterMark", cx.lineStart, cx.lineStart + 3),
            );
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("FrontMatter", 0, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

const EQUALS = 61;

/** A table line's cells, as markdown-it splits them: at its unescaped
 * `|`, an outer one at each end dropped. */
function tableCells(text: string): string[] {
  let line = text.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (char === "\\" && line[at + 1] === "|") {
      cell += "\\|";
      at++;
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** Whether markdown-it reads a table from these two lines: a `|` in the
 * header, a delimiter row of as many columns. */
function readsAsTable(header: string, delimiter: string): boolean {
  if (!header.includes("|")) return false;
  const columns = tableCells(delimiter);
  return (
    columns.every((cell) => DELIMITER_CELL.test(cell)) &&
    tableCells(header).length === columns.length
  );
}

/** A setext underline never under a table: @lezer/markdown made a table
 * followed by `===` or `---` a heading, where the preview's markdown-it
 * keeps the table — found by the outline's property (after phase 17). The
 * paragraph that is a table for markdown-it ends before
 * such a line: `---` is then a rule after the table, as in the preview;
 * `===` a paragraph of its own (a row of the table in the preview; the
 * same text shown, no heading either way). @lezer/markdown's setext
 * parser stays: a rule breaks a paragraph only when it is there. */
const setextUnderTable: MarkdownConfig = {
  parseBlock: [
    {
      name: "SetextUnderTable",
      endLeaf(_cx, line, leaf) {
        const mark = line.next;
        if (mark !== EQUALS && mark !== MINUS) return false;
        const rest = line.text.slice(line.pos);
        if (!/^(=+|-+)[ \t]*$/.test(rest)) return false;
        const [header, delimiter] = leaf.content.split("\n");
        return delimiter !== undefined && readsAsTable(header ?? "", delimiter);
      },
    },
  ],
};

/** Up to `count` quote markers off the start of `text`. */
function withoutQuoteMarkers(text: string, count: number): string {
  let rest = text;
  for (let i = 0; i < count; i++) {
    const marker = /^[ \t]*>[ \t]?/.exec(rest);
    if (!marker) break;
    rest = rest.slice(marker[0].length);
  }
  return rest;
}

/** A table interrupts a paragraph wherever markdown-it reads one:
 * @lezer/markdown's own rule never in a paragraph whose first line
 * has a `|`, and read the next line from the header's column. The next
 * line loses the quote markers the header has, no more: a lazy header
 * ends the quotes it would have continued, and a delimiter row with
 * another quote's marker is no delimiter row. Never in a table already,
 * nor before the delimiter row of the leaf's own first line. */
const tableAfterText: MarkdownConfig = {
  parseBlock: [
    {
      name: "TableAfterText",
      endLeaf(cx, line, leaf) {
        const header = line.text.slice(line.pos);
        if (!header.includes("|")) return false;
        const [first = "", second] = leaf.content.split("\n");
        if (readsAsTable(first, second ?? header)) return false;
        const quotes = (line.text.slice(0, line.pos).match(/>/g) ?? []).length;
        return readsAsTable(header, withoutQuoteMarkers(cx.peekLine(), quotes));
      },
      before: "Table",
    },
  ],
};

/** The editor's Markdown: CommonMark with what the
 * preview's markdown-it adds (ADR-0021) — tables, strikethrough, task
 * lists — and formulas by its "dollars" rules (`math-syntax.ts`), highlighted
 * in both modes. Not all of GFM: its bare `www.`
 * autolinks are not links in the preview (no `linkify`). */
export function markdownSyntax(): Extension {
  return [markdownSupport(), syntaxHighlighting(highlighter), theme];
}

let support: LanguageSupport | undefined;

/** What `markdown()` of lang-markdown makes, without its HTML: no tag
 * parsed as HTML inside the text (the editor shows none of its tokens,
 * and its `Document` of its own misled the walks up the tree), no
 * completion of tags (the editor has no `autocompletion()`), no folding
 * of sections (nor any folding). Not calling `markdown()` keeps the
 * grammars of HTML, CSS and JavaScript out of the page
 * (docs/taille-du-bundle.md, piste 1; `build-page.mjs` refuses them). */
function markdownSupport(): LanguageSupport {
  support ??= new LanguageSupport(
    new Language(
      commonmarkLanguage.data,
      (commonmarkLanguage.parser as MarkdownParser).configure([
        Table,
        Strikethrough,
        TaskList,
        mathExtension,
        highlightExtension,
        wikilinkExtension,
        codeAfterEscape,
        frontMatter,
        calloutMarks,
        calloutTitle,
        setextUnderTable,
        tableAfterText,
      ]),
      [],
      "markdown",
    ),
    [pasteURLAsLink, Prec.high(keymap.of(markdownKeymap))],
  );
  return support;
}

/** The editor's own parser, outside the editor: what reads the text
 * where no editor parses it whole (the outline). */
export function markdownParser(): MarkdownParser {
  return markdownSupport().language.parser as MarkdownParser;
}
