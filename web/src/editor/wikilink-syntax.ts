import { Tag, tags } from "@lezer/highlight";
import {
  type Element,
  InlineContext,
  type MarkdownConfig,
} from "@lezer/markdown";
import { readWikilink } from "../render/index.js";

/** A `[[…]]`'s shown part (markdown-syntax.ts). */
export const wikilinkTag = Tag.define();

const OPEN_BRACKET = 91;

/** Obsidian's `[[…]]` in the editor's Markdown, as
 * the preview's rule reads it — the same scanner, `readWikilink`, before
 * links: `Wikilink`, its `WikilinkMark`s (`[[`, `|`, `]]`), its
 * `WikilinkTarget` and its `WikilinkAlias`. What it is (a heading, a
 * block, a note) is read again from its text where it matters
 * (live-preview.ts, link-click.ts). */
export const wikilinkExtension: MarkdownConfig = {
  defineNodes: [
    { name: "Wikilink", style: { "Wikilink/...": wikilinkTag } },
    { name: "WikilinkMark", style: tags.processingInstruction },
    { name: "WikilinkTarget" },
    { name: "WikilinkAlias" },
  ],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET)
          return -1;
        // The character before, for an embed's `!`.
        const from = pos > cx.offset ? pos - 1 : pos;
        const found = readWikilink(cx.slice(from, cx.end), pos - from);
        if (!found) return -1;
        const end = from + found.end;
        const targetEnd = pos + 2 + found.target.length;
        const parts: Element[] = [
          cx.elt("WikilinkMark", pos, pos + 2),
          cx.elt("WikilinkTarget", pos + 2, targetEnd),
        ];
        if (targetEnd < end - 2) {
          parts.push(cx.elt("WikilinkMark", targetEnd, targetEnd + 1));
          if (found.alias !== null)
            parts.push(cx.elt("WikilinkAlias", targetEnd + 1, end - 2));
        }
        parts.push(cx.elt("WikilinkMark", end - 2, end));
        unopenLinks(cx);
        return cx.addElement(cx.elt("Wikilink", pos, end, parts));
      },
    },
  ],
};

/** A link never holds another (CommonMark; markdown-it's `parseLinkLabel`
 * refuses a label with a `[[…]]` in it): a `[` still open before a
 * `[[…]]` no longer opens a link, as @lezer/markdown does for the `[`
 * before one of its own links. Its `side`, set to none the same way, is
 * the one field outside its typed interface. */
function unopenLinks(cx: InlineContext): void {
  for (
    let i = cx.findOpeningDelimiter(InlineContext.linkStart);
    i !== null;
    i = cx.findOpeningDelimiter(InlineContext.linkStart)
  ) {
    (cx.getDelimiterAt(i) as unknown as { side: number }).side = 0;
  }
}
