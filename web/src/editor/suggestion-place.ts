// Where a suggestion at the caret goes. At a line's start, the
// position is before the line's markup: a text proposed there would land
// in front of a heading's `###`, and, accepted, turn it into a paragraph.
// So, at the start of a line, there are two places: before the line, as a
// paragraph of its own; or at the start of its text, after its markup.
import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { markdownParser } from "./markdown-syntax.js";

export interface AdditionPlaces {
  /** Before the line, as a paragraph of its own (`asOwnParagraph`). */
  paragraph: number;
  /** At the start of the line's text, after its markup; none where it
   * would join a neighbour (a blank line) or break the construct (a
   * table, a rule). */
  inline?: number;
  preferred: "paragraph" | "inline";
}

/** A line's markup, skipped to find its text. */
const MARKS = new Set(["HeaderMark", "ListMark", "QuoteMark", "TaskMarker"]);

/** Constructs that a paragraph before one of their lines, but the first,
 * would break apart (a paragraph: what spans its lines, emphasis, a
 * formula); code and formulas, where it would be text. */
const WHOLE = new Set([
  "Paragraph",
  // A task item's paragraph.
  "Task",
  "Table",
  "SetextHeading1",
  "SetextHeading2",
  "HTMLBlock",
  "CommentBlock",
  "FencedCode",
  "CodeBlock",
  "MathBlock",
]);

/** Constructs that have no text to start in the line. */
const NO_TEXT = new Set(
  [...WHOLE, "HorizontalRule"].filter(
    (name) => name !== "Paragraph" && name !== "Task",
  ),
);

const PARSE_BUDGET_MS = 50;

function treeOf(state: EditorState): Tree {
  return (
    ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ??
    markdownParser().parse(state.doc.toString())
  );
}

/** The nodes around `pos`, on either side: a blank line in a block is
 * only in it from its end. */
function ancestors(tree: Tree, pos: number): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (const side of [-1, 1] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node;
      node = node.parent
    ) {
      nodes.push(node);
    }
  }
  return nodes;
}

/** Where a suggestion at the caret `at` may go, when there is a choice
 * (or a blank line, where it must be a paragraph); null in the middle of
 * a line's text, in code, or within a table. */
export function additionPlaces(
  state: EditorState,
  at: number,
): AdditionPlaces | null {
  const line = state.doc.lineAt(at);
  const tree = treeOf(state);
  const around = ancestors(tree, line.from);
  if (
    around.some(
      (node) =>
        (WHOLE.has(node.name) && node.from < line.from) ||
        // Before the YAML header, it would no longer be one.
        node.name === "FrontMatter",
    )
  ) {
    return null;
  }
  if (line.text.trim() === "") {
    return { paragraph: line.from, preferred: "paragraph" };
  }
  if (continuesFootnote(state.doc, line.number)) return null;
  // The text's start: past the markup, and the spaces around it.
  let text = line.from;
  let marked = false;
  for (;;) {
    while (text < line.to && /[ \t]/.test(state.sliceDoc(text, text + 1))) {
      text++;
    }
    const node = tree.resolveInner(text, 1);
    if (!MARKS.has(node.name) || node.from !== text) break;
    text = node.to;
    marked = true;
  }
  if (!marked) text = line.from;
  if (at !== line.from && at !== text) return null;
  if (
    around.some((node) => NO_TEXT.has(node.name) && node.from === line.from)
  ) {
    return { paragraph: line.from, preferred: "paragraph" };
  }
  return {
    paragraph: line.from,
    inline: text,
    preferred: marked ? "paragraph" : "inline",
  };
}

/** A note's definition, as the preview reads it (`footnote-jump.ts`). */
const FOOTNOTE = /^[ \t>]*\[\^[^\s\]]+\]:/;

/** Whether line `number` continues a note's text: the editor's parser
 * reads a note as a link's definition, ended with its line; the preview,
 * as a block its next lines continue, up to a blank line (ADR-0046 §8). */
function continuesFootnote(doc: Text, number: number): boolean {
  for (let n = number - 1; n >= 1 && !blank(doc, n); n--) {
    if (FOOTNOTE.test(doc.line(n).text)) return true;
  }
  return false;
}

function blank(doc: Text, lineNumber: number): boolean {
  return doc.line(lineNumber).text.trim() === "";
}

/** `text`, to insert at `at` (a line's start) as a paragraph of its own:
 * a blank line between it and what is before, and what is after — no
 * more than needed, and its own line breaks at its ends left out. */
export function asOwnParagraph(doc: Text, at: number, text: string): string {
  const line = doc.lineAt(at);
  const core = text.replace(/^\n+|\n+$/g, "");
  const before = line.number === 1 || blank(doc, line.number - 1) ? "" : "\n";
  let after: string;
  if (!blank(doc, line.number)) after = "\n\n";
  else if (line.number === doc.lines || blank(doc, line.number + 1)) {
    after = "";
  } else after = "\n";
  return `${before}${core}${after}`;
}
