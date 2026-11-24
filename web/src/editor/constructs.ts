// The constructions the page offers to write without knowing Markdown
// (ADR-0046 §1): the toolbar, the shortcuts, the / menu and the
// help read this one list. Names and examples are the dictionary's, by id.

/** Wrapped around a selection: its marks on both sides, the editor
 * parser's node for it (`markdown-syntax.ts`). */
export interface InlineConstruct {
  kind: "inline";
  id: "bold" | "italic" | "strikethrough" | "highlight" | "code";
  mark: string;
  node: string;
}

/** A prefix on each line the selection touches. */
export interface LineConstruct {
  kind: "line";
  id:
    | "paragraph"
    | "heading1"
    | "heading2"
    | "heading3"
    | "heading4"
    | "heading5"
    | "heading6"
    | "bulletList"
    | "orderedList"
    | "taskList"
    | "quote";
}

/** Put after the block the caret is in: its text, what is selected in
 * it after (an example typed over, or the caret), the editor parser's
 * node for it. */
export interface BlockConstruct {
  kind: "block";
  id: "callout" | "table" | "codeBlock" | "mathBlock" | "diagram" | "rule";
  template: string;
  selected: { from: number; to: number };
  node: string;
}

/** Those with a rule of their own: a link, a footnote, an image (asked
 * for, then uploaded: `image-insertion.ts`). */
export interface SpecialConstruct {
  kind: "special";
  id: "link" | "footnote" | "image";
}

export type Construct =
  | InlineConstruct
  | LineConstruct
  | BlockConstruct
  | SpecialConstruct;

export type ConstructId = Construct["id"];

/** The template marked: the caret as ‸, or a selection in ⟨…⟩. */
function block(
  id: BlockConstruct["id"],
  node: string,
  marked: string,
): BlockConstruct {
  const caret = marked.indexOf("‸");
  const from = caret >= 0 ? caret : marked.indexOf("⟨");
  const to = caret >= 0 ? caret : marked.indexOf("⟩") - 1;
  const template = marked.replace(/[‸⟨⟩]/g, "");
  return { kind: "block", id, node, template, selected: { from, to } };
}

export const CONSTRUCTS: readonly Construct[] = [
  { kind: "inline", id: "bold", mark: "**", node: "StrongEmphasis" },
  { kind: "inline", id: "italic", mark: "*", node: "Emphasis" },
  { kind: "inline", id: "strikethrough", mark: "~~", node: "Strikethrough" },
  { kind: "inline", id: "highlight", mark: "==", node: "Highlight" },
  { kind: "inline", id: "code", mark: "`", node: "InlineCode" },
  { kind: "special", id: "link" },
  { kind: "line", id: "paragraph" },
  { kind: "line", id: "heading1" },
  { kind: "line", id: "heading2" },
  { kind: "line", id: "heading3" },
  { kind: "line", id: "heading4" },
  { kind: "line", id: "heading5" },
  { kind: "line", id: "heading6" },
  { kind: "line", id: "bulletList" },
  { kind: "line", id: "orderedList" },
  { kind: "line", id: "taskList" },
  { kind: "line", id: "quote" },
  block("callout", "Blockquote", "> [!note]\n> ‸"),
  block("table", "Table", "| ‸ |  |\n| --- | --- |\n|  |  |"),
  block("codeBlock", "FencedCode", "```\n‸\n```"),
  // Not an empty line: a blank line in a formula is no formula to the
  // editor (ADR-0032 §10).
  block("mathBlock", "MathBlock", "$$\n⟨x^2⟩\n$$"),
  block("diagram", "FencedCode", "```mermaid\nflowchart LR\n  A --> B‸\n```"),
  // Not `---`: at the text's start, it opens the YAML header.
  block("rule", "HorizontalRule", "***‸"),
  { kind: "special", id: "footnote" },
  { kind: "special", id: "image" },
];

/** A callout of `family` (ADR-0063, EN3): its title after the header if
 * any, the caret in its body, as the callout's. */
export function calloutConstruct(
  family: string,
  title: string,
): BlockConstruct {
  return block(
    "callout",
    "Blockquote",
    `> [!${family}]${title ? ` ${title.replace(/[‸⟨⟩]/g, "")}` : ""}\n> ‸`,
  );
}

export function construct(id: ConstructId): Construct {
  const found = CONSTRUCTS.find((each) => each.id === id);
  if (!found) throw new Error(`no construct ${id}`);
  return found;
}
