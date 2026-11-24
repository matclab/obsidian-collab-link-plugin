import { Tag, tags } from "@lezer/highlight";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { highlightColor } from "../render/index.js";

/** The text of a highlight, drawn on its background (markdown-syntax.ts). */
export const highlightTag = Tag.define();

const EQUALS = 61;

/** What markdown-it counts as punctuation around a delimiter (CommonMark
 * 0.31: symbols too, an emoji among them). */
const PUNCTUATION = /^[\p{S}\p{P}]$/u;

/** The character before `pos` and the one at `pos`, whole: markdown-it
 * reads a surrogate pair as one (`@lezer/markdown`, one code unit). */
function around(cx: InlineContext, before: number, after: number) {
  const back = cx.slice(Math.max(cx.offset, before - 2), before);
  const ahead = cx.slice(after, after + 2);
  const last = [...back].at(-1) ?? "";
  const next = [...ahead][0] ?? "";
  return { last, next };
}

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** Obsidian's highlights in the editor's Markdown (ADR-0044), as
 * `markdown-it-mark` reads them in the preview: `==` delimiters, a run of
 * `=` read whole (the flanking rules of `~~`, ADR-0044 point 6);
 * `HighlightColor` for one of `HIGHLIGHT_COLORS`' emojis right after a
 * `==`, a color only at a highlight's opening (live-preview.ts). */
export const highlightExtension: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: tags.processingInstruction },
    { name: "HighlightColor" },
  ],
  parseInline: [
    {
      name: "Highlight",
      // A run of `=` read whole, as markdown-it-mark does: whether it
      // opens or closes is judged on the characters around the run; one
      // delimiter per pair, an odd `=` is text — at the run's start, or,
      // when its first pair closes, after the pairs (there, moved after
      // the closing tags; here, guessed from a highlight still open on the
      // left). There, a pair never pairs with another of its run: here,
      // every pair may close, the last only may open (a run opening two
      // highlights, one inside the other, `====a== b==`, opens one).
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== EQUALS) return -1;
        let end = pos + 1;
        while (cx.char(end) === EQUALS) end++;
        if (end - pos < 2) return -1;
        const { last: before, next: after } = around(cx, pos, end);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCTUATION.test(before);
        const pAfter = PUNCTUATION.test(after);
        const open = !sAfter && (!pAfter || sBefore || pBefore);
        const close = !sBefore && (!pBefore || sAfter || pAfter);
        if (!open && !close) return end;
        const closes =
          close && cx.findOpeningDelimiter(HighlightDelim) !== null;
        const first = pos + ((end - pos) % 2 === 1 && !closes ? 1 : 0);
        const last = first + (end - pos) - ((end - pos) % 2);
        for (let at = first; at < last; at += 2) {
          cx.addDelimiter(
            HighlightDelim,
            at,
            at + 2,
            open && at + 2 === last,
            close,
          );
        }
        return end;
      },
      after: "Emphasis",
    },
    {
      name: "HighlightColor",
      parse(cx: InlineContext, _next: number, pos: number) {
        if (
          pos - 2 < cx.offset ||
          cx.char(pos - 1) !== EQUALS ||
          cx.char(pos - 2) !== EQUALS
        )
          return -1;
        const found = highlightColor(cx.slice(pos, pos + 2));
        if (!found) return -1;
        return cx.addElement(cx.elt("HighlightColor", pos, pos + found.length));
      },
      before: "Highlight",
    },
  ],
};
