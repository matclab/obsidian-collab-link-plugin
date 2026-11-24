import type { Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type {
  BlockContext,
  InlineContext,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

// The "dollars" rules of markdown-it-texmath 1.0, which the preview applies
// (render/, ADR-0021), copied here: both parsers must find the same
// formulas (a differential property checks it).
const INLINE_DOUBLE = /^\$\$([^$]*?[^\\])\$\$/;
const INLINE_SINGLE = /^\$((?:[^\s\\])|(?:\S.*?[^\s\\]))\$/;
const BLOCK_NUMBERED = /^\$\$([^$]*?[^\\])\$\$\s*?\(([^)\s]+?)\)/;
const BLOCK = /^\$\$([^$]*?[^\\])\$\$/;
// A close the numbered rule could still take, its number on a later line:
// nothing but spaces after it (with `$$$`, one `$` further than the plain
// rule's).
const BLOCK_NUMBER_AHEAD = /^\$\$([^$]*?[^\\])\$\$\s*$/;

const DOLLAR = 36;
const BACKSLASH = 92;
const isDigit = (code: number) => code >= 48 && code <= 57;

/** An opening `$` follows neither a backslash nor a digit. */
function openable(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset) return true;
  const before = cx.char(pos - 1);
  return before !== BACKSLASH && !isDigit(before);
}

/** Formulas in the editor's Markdown: `InlineMath`
 * (`$…$`), `DisplayMath` (`$$…$$` inside a paragraph), `MathBlock` (a block
 * that starts with `$$`, closed on its first line or a later one,
 * optionally numbered `(n)`; the rest of its closing line goes with it, as
 * in the preview; cannot interrupt a paragraph). `MathMark` for their dollars, `MathTag`
 * for a block's number. Their content is not Markdown. */
export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.monospace },
    { name: "DisplayMath", style: tags.monospace },
    { name: "MathBlock", block: true, style: tags.monospace },
    { name: "MathMark", style: tags.processingInstruction },
    { name: "MathTag", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Math",
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== DOLLAR || !openable(cx, pos)) return -1;
        const rest = cx.slice(pos, cx.end);
        for (const [rule, name, marks] of [
          [INLINE_DOUBLE, "DisplayMath", 2],
          [INLINE_SINGLE, "InlineMath", 1],
        ] as const) {
          const match = rule.exec(rest);
          if (!match) continue;
          const end = pos + match[0].length;
          if (isDigit(cx.char(end))) continue;
          return cx.addElement(
            cx.elt(name, pos, end, [
              cx.elt("MathMark", pos, pos + marks),
              cx.elt("MathMark", end - marks, end),
            ]),
          );
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "MathBlock",
      before: "LinkReference",
      leaf: (_cx, leaf) =>
        leaf.content.startsWith("$$") ? new MathBlockParser(leaf) : null,
    },
  ],
};

/** A `MathBlock`, read as a paragraph-like block (the user's
 * choice): incremental parsing stays exact, at the cost of known
 * divergences from the preview, which reads on to the closing `$$` (and its
 * number) whatever lies between — a blank line inside the formula or
 * before its number, or one of its lines that starts a list, a heading or a
 * quote, ends the block; the editor then shows the source. */
class MathBlockParser implements LeafBlockParser {
  /** Failed: the first `$` after the opening is no close. */
  private failed: boolean;
  /** Each line's start, in the leaf's content and in the document. */
  private readonly starts: [number, number][];

  constructor(leaf: LeafBlock) {
    this.failed = closing(leaf.content) === "failed";
    this.starts = [[0, leaf.start]];
  }

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.failed) return false;
    const text = asLeafHoldsIt(line);
    const content = `${leaf.content}\n${text}`;
    const before = closing(leaf.content);
    const now = closing(content);
    if (typeof before !== "string") {
      // Closed already; a number may follow on this line (the preview's
      // space before it crosses a line break).
      if (
        typeof now !== "string" &&
        now.tag !== undefined &&
        before.tag === undefined
      ) {
        this.starts.push([leaf.content.length + 1, cx.lineStart]);
        const lineEnd = cx.lineStart + line.text.length;
        cx.nextLine();
        cx.addLeafElement(leaf, this.block(cx, now, lineEnd));
        return true;
      }
      cx.addLeafElement(leaf, this.block(cx, before, cx.prevLineEnd()));
      return true;
    }
    if (now === "failed") {
      this.failed = true;
      return false;
    }
    this.starts.push([leaf.content.length + 1, cx.lineStart]);
    if (now === "open") return false;
    if (now.tag === undefined && BLOCK_NUMBER_AHEAD.test(content)) {
      // Its number may be on the next line: wait for it.
      return false;
    }
    // Closed on this line: the rest of it goes with the block.
    const lineEnd = cx.lineStart + line.text.length;
    cx.nextLine();
    cx.addLeafElement(leaf, this.block(cx, now, lineEnd));
    return true;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (this.failed) return false;
    const found = closing(leaf.content);
    if (typeof found === "string") return false;
    cx.addLeafElement(leaf, this.block(cx, found, cx.prevLineEnd()));
    return true;
  }

  /** The document position of an offset in the leaf's content. */
  private at(offset: number): number {
    let line = this.starts[0] as [number, number];
    for (const start of this.starts) if (start[0] <= offset) line = start;
    return line[1] + (offset - line[0]);
  }

  private block(cx: BlockContext, found: Closing, end: number) {
    const start = this.at(0);
    const closeAt = this.at(found.close);
    const children = [
      cx.elt("MathMark", start, start + 2),
      cx.elt("MathMark", closeAt, closeAt + 2),
    ];
    if (found.tag !== undefined)
      children.push(cx.elt("MathTag", this.at(found.tag), this.at(found.end)));
    return cx.elt("MathBlock", start, end, children);
  }
}

/** A line as a leaf holds it: its containers' markers turned to spaces,
 * so that offsets in it are offsets in the line (`Line.scrub`, which
 * @lezer/markdown does not export in its types). */
function asLeafHoldsIt(line: Line): string {
  if (!line.baseIndent) return line.text;
  return " ".repeat(line.basePos) + line.text.slice(line.basePos);
}

interface Closing {
  /** Offset of the closing `$$` in the content. */
  close: number;
  /** Offset of a number's `(`, when numbered. */
  tag?: number;
  end: number;
}

/** Where the content's formula closes, by the preview's rules: "open" when
 * no `$` follows the opening yet, "failed" when the first one is no close. */
function closing(content: string): Closing | "open" | "failed" {
  if (content.indexOf("$", 2) < 0) return "open";
  // No condition on what follows, unlike inline formulas: the preview's
  // block rules have none. From the groups: after the opening `$$`, the
  // content; the number is the last group, in its parentheses.
  const numbered = BLOCK_NUMBERED.exec(content);
  if (numbered) {
    const end = numbered[0].length;
    return {
      close: 2 + (numbered[1] ?? "").length,
      tag: end - (numbered[2] ?? "").length - 2,
      end,
    };
  }
  const plain = BLOCK.exec(content);
  if (plain)
    return { close: 2 + (plain[1] ?? "").length, end: plain[0].length };
  return "failed";
}

/** The formulas of a tree, in order: what the differential property
 * compares with the preview's. */
export function formulas(
  tree: Tree,
  doc: Text,
): { kind: "inline" | "display" | "block"; tex: string; tag?: string }[] {
  const found: {
    kind: "inline" | "display" | "block";
    tex: string;
    tag?: string;
  }[] = [];
  tree.iterate({
    enter(ref) {
      const kind =
        ref.name === "InlineMath"
          ? "inline"
          : ref.name === "DisplayMath"
            ? "display"
            : ref.name === "MathBlock"
              ? "block"
              : null;
      if (!kind) return;
      const marks = ref.node.getChildren("MathMark");
      const open = marks[0];
      const close = marks[1];
      if (!open || !close) return false;
      const tag = ref.node.getChild("MathTag");
      found.push({
        kind,
        tex: doc.sliceString(open.to, close.from),
        ...(tag && { tag: doc.sliceString(tag.from + 1, tag.to - 1) }),
      });
      return false;
    },
  });
  return found;
}
