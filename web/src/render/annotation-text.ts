// The text of an annotation — a comment, a suggestion's note, a reply — as
// HTML (ADR-0047): a subset of the preview's Markdown, pure and synchronous,
// no link inside the document, no image, no id.
import MarkdownIt from "markdown-it";
import type { MarkdownIt as Md, StateBlock } from "markdown-it";
import { LEAVES_DOCUMENT, highlights, leavingHref } from "./render.js";

type PluginSimple = (md: Md) => void;

/** A line that starts with `[^`: a paragraph's start, as it would be with
 * the footnotes of the preview. Without them, CommonMark reads `[^1]: x`
 * as a link reference definition and drops the line:
 * nothing a reviewer wrote may vanish. Read as markdown-it's paragraph
 * rule does; a definition can't interrupt a paragraph, so a later line
 * needs no rule. */
const footnoteDefinitionsAsText: PluginSimple = (md) => {
  md.block.ruler.before(
    "reference",
    "footnote_text",
    (state: StateBlock, start, end, silent) => {
      const indent = (line: number) =>
        (state.sCount[line] ?? 0) - state.blkIndent;
      if (silent || indent(start) >= 4) return false;
      const from = (state.bMarks[start] ?? 0) + (state.tShift[start] ?? 0);
      if (!state.src.startsWith("[^", from)) return false;
      const terminators = state.md.block.ruler.getRules("paragraph");
      const parent = state.parentType;
      state.parentType = "paragraph";
      let next = start + 1;
      for (; next < end && !state.isEmpty(next); next++) {
        if (indent(next) > 3 || (state.sCount[next] ?? 0) < 0) continue;
        if (terminators.some((rule) => rule(state, next, end, true))) break;
      }
      const content = state.getLines(start, next, state.blkIndent, false);
      state.line = next;
      state.push("paragraph_open", "p", 1).map = [start, next];
      const inline = state.push("inline", "", 0);
      inline.content = content.trim();
      inline.map = [start, next];
      inline.children = [];
      state.push("paragraph_close", "p", -1);
      state.parentType = parent;
      return true;
    },
  );
};

/** A link is an `<a>` only when its address leaves the document
 * (`leavingHref`, ADR-0047 §4), in a new tab, its title dropped; any other
 * is its text. The opening's choice is kept on its token for the closing:
 * links don't nest, the last opened is this one's. */
const linksLeavingOnly: PluginSimple = (md) => {
  const escapeHtml = md.utils.escapeHtml;
  md.renderer.rules.link_open = (tokens, idx) => {
    const token = tokens[idx];
    const href = leavingHref(String(token?.attrGet("href") ?? ""));
    if (token) token.meta = { ...token.meta, leaves: href !== null };
    return href === null
      ? ""
      : `<a href="${escapeHtml(href)}"${LEAVES_DOCUMENT}>`;
  };
  md.renderer.rules.link_close = (tokens, idx) => {
    for (let i = idx - 1; i >= 0; i--) {
      if (tokens[i]?.type === "link_open") {
        return tokens[i]?.meta?.leaves ? "</a>" : "";
      }
    }
    return "";
  };
};

/** No image is shown (ADR-0047 §5): one that leaves the document is a link
 * to it, by its text or else its address (`remote-image`, as the preview);
 * any other, its text. */
const imagesAsText: PluginSimple = (md) => {
  const escapeHtml = md.utils.escapeHtml;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const alt = self.renderInlineAsText(token?.children ?? [], options, env);
    const href = leavingHref(String(token?.attrGet("src") ?? ""));
    if (href === null) return escapeHtml(alt);
    return `<a class="remote-image" href="${escapeHtml(href)}"${LEAVES_DOCUMENT}>${escapeHtml(alt || href)}</a>`;
  };
};

const md = new MarkdownIt("commonmark", {
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
  xhtmlOut: false,
})
  .disable(["heading", "lheading", "hr"])
  .enable("strikethrough")
  .use(highlights)
  .use(footnoteDefinitionsAsText)
  .use(linksLeavingOnly)
  .use(imagesAsText);

export function renderAnnotationText(text: string): string {
  return md.render(text);
}
