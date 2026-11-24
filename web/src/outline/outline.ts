// The document's outline (docs/phase-16-plan-du-document.md, decision 4):
// its headings, read by the editor's own parser, pure and synchronous.
import { DocInput } from "@codemirror/language";
import { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { visibleText } from "../editor/live-preview.js";
import { markdownParser } from "../editor/markdown-syntax.js";

/** One heading of the document. */
export interface OutlineHeading {
  /** 1 to 6. */
  level: number;
  /** What the preview shows of it, on one line. */
  text: string;
  /** Its raw text, as Obsidian's metadataCache gives it: without its
   * opening and closing marks, on one line (decision 8). */
  source: string;
  /** Where its first line starts in the text, and that line, from 0. */
  from: number;
  line: number;
}

const HEADING = /^(?:ATXHeading|SetextHeading)(\d)$/;

/** One line, its runs of white space one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The heading `node` is, or `undefined`: a top-level block only — the
 * document's own headings, none in a quote, a list or a callout, as
 * Obsidian's outline (*Relevé 16a*). */
export function headingOf(
  node: SyntaxNode,
  tree: Tree,
  doc: Text,
): OutlineHeading | undefined {
  const level = HEADING.exec(node.name)?.[1];
  if (!level) return undefined;
  const marks = node.getChildren("HeaderMark");
  let from = node.from;
  let to = node.to;
  let shownTo = node.to;
  if (node.name.startsWith("ATX")) {
    const [opening, closing] = marks;
    if (opening) from = opening.to;
    if (closing && closing !== opening) to = closing.from;
  } else {
    // Setext: the text above its underline.
    const underline = marks[marks.length - 1];
    if (underline) to = shownTo = underline.from;
  }
  const first = doc.lineAt(node.from);
  return {
    level: Number(level),
    text: oneLine(visibleText(tree, doc, node.from, shownTo)),
    source: oneLine(doc.sliceString(from, to)),
    from: first.from,
    line: first.number - 1,
  };
}

/** Every heading of the document, from its tree. */
export function outlineOf(tree: Tree, doc: Text): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const heading = headingOf(node, tree, doc);
    if (heading) headings.push(heading);
  }
  return headings;
}

/** Parses `doc` whole with the editor's parser. */
export function parseWhole(doc: Text): Tree {
  return markdownParser().parse(new DocInput(doc));
}

/** Every heading of `text`. */
export function outlineOfText(text: string): OutlineHeading[] {
  const doc = Text.of(text.split("\n"));
  return outlineOf(parseWhole(doc), doc);
}
