import type { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { type CalloutHeader, calloutHeader } from "../render/index.js";

/** The callout a `Blockquote` is, read on its first paragraph's
 * first line as written, when that is the quote's own first line (`render/callout.ts`, as the preview), or
 * undefined. `from`: where its header starts. */
export function calloutOf(
  node: SyntaxNode,
  doc: Text,
): { header: CalloutHeader; from: number } | undefined {
  let paragraph = node.firstChild;
  while (paragraph?.name === "QuoteMark") paragraph = paragraph.nextSibling;
  if (
    paragraph?.name !== "Paragraph" ||
    paragraph.firstChild?.name !== "CalloutMark" ||
    paragraph.firstChild.from !== paragraph.from
  )
    return undefined;
  const line = doc.lineAt(paragraph.from);
  // On the quote's first line only, as Obsidian (essai 15e.2).
  if (line.number !== doc.lineAt(node.from).number) return undefined;
  const header = calloutHeader(line.text, paragraph.from - line.from);
  return header ? { header, from: paragraph.from } : undefined;
}
