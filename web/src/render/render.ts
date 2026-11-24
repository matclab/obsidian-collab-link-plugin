// Markdown -> HTML string, pure and synchronous (ADR-0021 §2). Formulas and
// diagrams come out as placeholders the display layer fills later.
import MarkdownIt from "markdown-it";
import type {
  MarkdownIt as Md,
  StateBlock,
  StateCore,
  StateInline,
  Token,
} from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import texmath from "markdown-it-texmath";
import { isAttachmentId } from "../../lib/src/index.js";
import { count } from "../perf/index.js";
import { CALLOUT_FOLD_ICON, calloutIcon } from "./callout-icons.js";
import {
  type CalloutHeader,
  calloutHeader,
  defaultCalloutTitle,
} from "./callout.js";
import { loadableImageSource } from "./remote-image.js";
import { type RenderedHtml, markdownItHtml } from "./trusted-html.js";
import { type Wikilink, readWikilink } from "./wikilink.js";

type PluginSimple = (md: Md) => void;

/** Footnote ids, `fn-md-1` and `fnref-md-1`, stay apart from the page's. */
const footnotes: PluginSimple = (md) => {
  md.use(footnote);
  md.renderer.rules.footnote_anchor_name = (tokens, idx) =>
    `-md-${Number(tokens[idx]?.meta?.id) + 1}`;
};

/** The colors a highlight may name by its leading emoji (Obsidian 1.14,
 * ADR-0044), the emoji itself not shown. */
export const HIGHLIGHT_COLORS = {
  "🔴": "red",
  "🟠": "orange",
  "🟡": "yellow",
  "🟢": "green",
  "🔵": "blue",
  "🟣": "purple",
} as const;

export type HighlightColor =
  (typeof HIGHLIGHT_COLORS)[keyof typeof HIGHLIGHT_COLORS];

/** The color `text` starts with, and its emoji's length; none if another
 * character starts it. */
export function highlightColor(
  text: string,
): { color: HighlightColor; length: number } | undefined {
  const first = String.fromCodePoint(text.codePointAt(0) ?? 0);
  const color = HIGHLIGHT_COLORS[first as keyof typeof HIGHLIGHT_COLORS];
  return color ? { color, length: first.length } : undefined;
}

/** `==text==` becomes `<mark>` (`markdown-it-mark`); an emoji of
 * `HIGHLIGHT_COLORS` right after the opening, its color's class. Shared
 * with the annotations' text (ADR-0047 §2). */
export const highlights: PluginSimple = (md) => {
  md.use(mark);
  md.core.ruler.after("inline", "highlight_colors", (state: StateCore) => {
    for (const block of state.tokens) {
      const children = block.children ?? [];
      for (let i = 0; i + 1 < children.length; i++) {
        const open = children[i];
        const text = children[i + 1];
        if (open?.type !== "mark_open" || text?.type !== "text") continue;
        const found = highlightColor(text.content);
        if (!found) continue;
        open.attrSet("class", `md-highlight-${found.color}`);
        text.content = text.content.slice(found.length);
      }
    }
  });
};

/** `[ ]` or `[x]` then a space, at the start of a list item's first
 * paragraph, becomes a read-only checkbox (GFM task lists): not
 * `disabled`, which greys it out, an unticked box almost unseen; out of
 * the keys' way, and the page's style takes the pointer's clicks away. */
const taskLists: PluginSimple = (md) => {
  md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (
        inline?.type !== "inline" ||
        tokens[i - 1]?.type !== "paragraph_open" ||
        tokens[i - 2]?.type !== "list_item_open"
      ) {
        continue;
      }
      const marker = /^\[([ xX])\][ \t]/.exec(inline.content);
      const first = inline.children?.[0];
      if (!marker || first?.type !== "text") continue;
      first.content = first.content.slice(marker[0].length);
      const box = new state.Token("task_checkbox", "input", 0);
      box.meta = { checked: marker[1] !== " " };
      inline.children?.unshift(box);
      tokens[i - 2]?.attrJoin("class", "task-list-item");
    }
    return false;
  });
  md.renderer.rules.task_checkbox = (tokens, idx) =>
    `<input type="checkbox" aria-disabled="true" tabindex="-1"${tokens[idx]?.meta?.checked ? " checked" : ""}> `;
};

// An item's markers, nested ones too.
const ITEM = /^(([-*+]|\d{1,9}[.)])([ \t]+|$))+/;
// An item that may interrupt a paragraph: not empty, numbered from 1.
const INTERRUPTS = /^([-*+]|1[.)])[ \t]+\S/;

/** Tables as the editor's parser reads them, where a table is
 * a paragraph's reading: after the other blocks (`> a | b` is a quote,
 * `1. a | b` an item, never a table's cells); on lazy lines too, where
 * markdown-it read the paragraph's text. A lazy header line ends the
 * paragraph — the item, the quote — it would have continued; the table's
 * other lines, lazy, stay in it. */
const lazyTables: PluginSimple = (md) => {
  const { ruler } = md.block;
  const table = ruler.__rules__[ruler.__find__("table")]?.fn;
  if (!table) throw new Error("markdown-it has no table rule");
  // `run` reads the lines from `from` to `to`, lazy ones as the block's.
  const asTheBlocks = <T>(
    state: StateBlock,
    from: number,
    to: number,
    run: () => T,
  ): T => {
    const lowered = new Map<number, number>();
    for (let line = from; line < to && !state.isEmpty(line); line++) {
      const count = state.sCount[line] ?? 0;
      if (count >= state.blkIndent) continue;
      lowered.set(line, count);
      state.sCount[line] = state.blkIndent;
    }
    try {
      return run();
    } finally {
      for (const [line, count] of lowered) state.sCount[line] = count;
    }
  };
  const lazyTable: typeof table = (state, startLine, endLine, silent) => {
    // Its delimiter line first: a paragraph asks at each of its lines.
    const after = startLine + 1;
    const found =
      (state.sCount[after] ?? 0) >= state.blkIndent
        ? table(state, startLine, endLine, true)
        : asTheBlocks(state, after, after + 1, () =>
            table(state, startLine, endLine, true),
          );
    if (!found || silent) return found;
    return asTheBlocks(state, after, endLine, () =>
      table(state, startLine, endLine, false),
    );
  };
  ruler.disable("table");
  ruler.before("lheading", "lazy_table", lazyTable, {
    alt: ["paragraph", "reference"],
  });

  // Where each quote being read starts, the innermost last.
  const quotes = new WeakMap<StateBlock, number[]>();
  const blockquote = ruler.__rules__[ruler.__find__("blockquote")];
  if (!blockquote) throw new Error("markdown-it has no blockquote rule");
  const quote = blockquote.fn;
  ruler.at(
    "blockquote",
    (state, startLine, endLine, silent) => {
      const starts = quotes.get(state) ?? [];
      quotes.set(state, starts);
      starts.push(startLine);
      try {
        return quote(state, startLine, endLine, silent);
      } finally {
        starts.pop();
      }
    },
    { alt: blockquote.alt },
  );
  // A line as written: a quote moves its lines' starts past its markers.
  const written = (state: StateBlock, line: number) =>
    state.src.slice(
      line === 0 ? 0 : (state.eMarks[line - 1] ?? 0) + 1,
      state.eMarks[line],
    );
  const markers = (state: StateBlock, line: number) =>
    /^([ \t]*>[ \t]?)*/.exec(written(state, line))?.[0] ?? "";
  // Its text without any quote's markers: a lazy line continues the
  // innermost paragraph, at any depth.
  const bare = (state: StateBlock, line: number) =>
    written(state, line).slice(markers(state, line).length).trim();
  const depth = (state: StateBlock, line: number) =>
    (markers(state, line).match(/>/g) ?? []).length;
  const twoLinesTable = (header: string, delimiter: string) =>
    table(
      new md.block.State(`${header}\n${delimiter}`, md, {}, []),
      0,
      2,
      true,
    );
  // A quote's lazy line that starts a table ends the quote, as a heading
  // would — unless it continues a table of the paragraph it is lazy for,
  // as its delimiter row or another row.
  ruler.before(
    "table",
    "table_after_quote",
    (state, startLine, endLine, silent) => {
      if (!silent || state.parentType !== "blockquote") return false;
      const start = quotes.get(state)?.at(-1) ?? startLine;
      // Back to that paragraph's first line, an item's.
      let first = startLine;
      while (first > start && bare(state, first - 1) !== "") {
        first--;
        if (INTERRUPTS.test(bare(state, first))) break;
      }
      for (let line = first; line < startLine; line++) {
        // A delimiter row deeper in quotes opens a quote of its own.
        if (
          depth(state, line + 1) <= depth(state, line) &&
          twoLinesTable(
            bare(state, line).replace(ITEM, ""),
            bare(state, line + 1),
          )
        ) {
          return false;
        }
      }
      return lazyTable(state, startLine, endLine, true);
    },
    { alt: ["blockquote"] },
  );
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `$…$` and `$$…$$` by texmath's rules (Pandoc's: `5 $ et 10 $` stays
 * text), rendered as placeholders. Its engine is never called: every rule
 * it registers is rendered here. */
const mathPlaceholders: PluginSimple = (md) => {
  md.use(texmath, {
    engine: { renderToString: () => "" },
    delimiters: "dollars",
  });
  const inline = (tex: string, display: boolean) => {
    const source = escapeHtml(tex);
    const kind = display ? "math math-display" : "math";
    return `<span class="${kind}" data-tex="${source}">${source}</span>`;
  };
  const block = (tex: string) => {
    const source = escapeHtml(tex);
    return `<div class="math math-display" data-tex="${source}">${source}</div>\n`;
  };
  // In a quote, texmath takes the quotes' markers out of a formula block
  // only when the quote is its parent: in a list in a quote, they stayed
  // in its TeX (11e.1b).
  md.core.ruler.push("math_quote_markers", (state) => {
    let depth = 0;
    for (const token of state.tokens) {
      if (token.type === "blockquote_open") depth++;
      else if (token.type === "blockquote_close") depth--;
      else if (
        depth > 0 &&
        (token.type === "math_block" || token.type === "math_block_eqno")
      )
        token.content = token.content.replace(
          new RegExp(`^(?:[ \\t]*>){1,${depth}}`, "gm"),
          "",
        );
    }
    return false;
  });
  const rules = md.renderer.rules;
  rules.math_inline = (tokens, idx) =>
    inline(tokens[idx]?.content ?? "", false);
  rules.math_inline_double = (tokens, idx) =>
    inline(tokens[idx]?.content ?? "", true);
  rules.math_block = (tokens, idx) => block(tokens[idx]?.content ?? "");
  rules.math_block_eqno = (tokens, idx) =>
    block(`${tokens[idx]?.content}\\tag{${tokens[idx]?.info}}`);
};

/** A `mermaid` code block becomes a placeholder; its source shows until the
 * display layer draws the diagram, or if it cannot. */
const mermaidPlaceholders: PluginSimple = (md) => {
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token?.info.trim().split(/\s+/)[0] !== "mermaid") {
      return fence ? fence(tokens, idx, options, env, self) : "";
    }
    const source = escapeHtml(token.content);
    return `<div class="mermaid" data-source="${source}"><pre><code>${source}</code></pre></div>\n`;
  };
};

/** A note's YAML header: a `---` line at the very
 * start of the text, up to the next `---` line or, not closed yet, to the
 * end — as the editor's parser reads it (`markdown-syntax.ts`), which
 * can't read ahead. Shown as written, never as Markdown. */
const frontMatter: PluginSimple = (md) => {
  md.block.ruler.before(
    "table",
    "front_matter",
    (state, start, end, silent) => {
      const line = (n: number) =>
        state.src.slice(state.bMarks[n] ?? 0, state.eMarks[n] ?? 0);
      // The text's own start: not a quote's or a list's first line.
      if (start !== 0 || state.bMarks[0] !== 0 || line(0) !== "---") {
        return false;
      }
      if (silent) return true;
      let close = 1;
      while (close < end && line(close) !== "---") close++;
      const token = state.push("front_matter", "pre", 0);
      token.block = true;
      token.content =
        close > 1
          ? state.src.slice(state.bMarks[1] ?? 0, state.eMarks[close - 1] ?? 0)
          : "";
      token.map = [0, Math.min(close + 1, end)];
      state.line = Math.min(close + 1, end);
      return true;
    },
  );
  md.renderer.rules.front_matter = (tokens, idx) =>
    `<pre class="front-matter"><code>${escapeHtml(tokens[idx]?.content ?? "")}</code></pre>\n`;
};

/** A quote whose first paragraph opens with `[!type]` is a callout. Its tokens
 * stay `blockquote_open`/`_close`, the callout
 * in `meta`: `math_quote_markers` counts them, and `renderMarkdownBlocks`
 * reads their level and lines. The header line is split off the paragraph
 * into the title, before inline parsing. */
const callouts: PluginSimple = (md) => {
  md.core.ruler.after("block", "callouts", (state: StateCore) => {
    const tokens = state.tokens;
    let lines: string[] | undefined;
    // One pass into a new list: a splice per callout into the whole list
    // cost the number of tokens for each callout.
    const out: Token[] = [];
    // The callouts open, innermost last: their level, their header, and
    // their content's opening (dropped when nothing follows the title).
    const open: { level: number; header: CalloutHeader; content: Token }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      const inner = open.at(-1);
      if (token.type === "blockquote_close" && token.level === inner?.level) {
        open.pop();
        if (out.at(-1) === inner.content) out.pop();
        else {
          const end = new state.Token("callout_content_close", "div", -1);
          end.block = true;
          end.level = inner.content.level;
          out.push(end);
        }
        token.meta = { callout: inner.header };
        out.push(token);
        continue;
      }
      out.push(token);
      const paragraph = tokens[i + 1];
      const inline = tokens[i + 2];
      if (
        token.type !== "blockquote_open" ||
        paragraph?.type !== "paragraph_open" ||
        inline?.type !== "inline" ||
        !paragraph.map ||
        // On the quote's first line only, as Obsidian (essai 15e.2): not
        // after a blank `>` line.
        token.map?.[0] !== paragraph.map[0]
      ) {
        continue;
      }
      // Read as written: markdown-it took a second space after `>` out.
      lines ??= state.src.split("\n");
      const line = (lines[paragraph.map[0]] ?? "").trimEnd();
      const newline = inline.content.indexOf("\n");
      const first = (
        newline < 0 ? inline.content : inline.content.slice(0, newline)
      ).trimEnd();
      if (!line.endsWith(first)) continue;
      const header = calloutHeader(line, line.length - first.length);
      if (!header) continue;
      token.meta = { callout: header };

      const title = header.title
        ? Object.assign(new state.Token("inline", "", 0), {
            content: header.title,
            children: [],
          })
        : Object.assign(new state.Token("callout_default_title", "", 0), {
            content: defaultCalloutTitle(header.type),
          });
      const titled = [
        new state.Token("callout_title_open", "div", 1),
        title,
        new state.Token("callout_title_close", "div", -1),
      ];
      for (const part of titled) {
        part.meta = { callout: header };
        part.block = part !== title;
        part.level = part === title ? paragraph.level + 1 : paragraph.level;
        part.map = [paragraph.map[0], paragraph.map[0] + 1];
      }
      out.push(...titled);
      const content = new state.Token("callout_content_open", "div", 1);
      content.block = true;
      content.level = paragraph.level;
      out.push(content);
      open.push({ level: token.level, header, content });
      const rest = newline < 0 ? "" : inline.content.slice(newline + 1);
      if (rest.trim() === "") {
        i += 3; // the paragraph was its title only
      } else {
        inline.content = rest;
        paragraph.map = [paragraph.map[0] + 1, paragraph.map[1]];
      }
    }
    state.tokens = out;
    return false;
  });
  // A fold sign makes a <details>, its title the summary (decision 4).
  const header = (tokens: Token[], idx: number) =>
    tokens[idx]?.meta?.callout as CalloutHeader | undefined;
  const rules = md.renderer.rules;
  rules.blockquote_open = (tokens, idx) => {
    const callout = header(tokens, idx);
    if (!callout) return "<blockquote>\n";
    const tag = callout.fold ? "details" : "div";
    const open = callout.fold === "+" ? " open" : "";
    return `<${tag} class="md-callout md-callout-${callout.family}" data-callout="${escapeHtml(callout.type)}"${open}>\n`;
  };
  rules.blockquote_close = (tokens, idx) => {
    const callout = header(tokens, idx);
    if (!callout) return "</blockquote>\n";
    return callout.fold ? "</details>\n" : "</div>\n";
  };
  // Its family's icon first (decision 6); a foldable one's chevron last.
  rules.callout_title_open = (tokens, idx) => {
    const callout = header(tokens, idx);
    const icon = `<span class="md-callout-icon">${calloutIcon(callout?.family ?? "note")}</span>`;
    return `<${callout?.fold ? "summary" : "div"} class="md-callout-title">${icon}`;
  };
  rules.callout_title_close = (tokens, idx) =>
    header(tokens, idx)?.fold
      ? `<span class="md-callout-fold">${CALLOUT_FOLD_ICON}</span></summary>\n`
      : "</div>\n";
  rules.callout_default_title = (tokens, idx) =>
    `<span class="md-callout-default-title">${escapeHtml(tokens[idx]?.content ?? "")}</span>`;
  rules.callout_content_open = () => '<div class="md-callout-content">\n';
  rules.callout_content_close = () => "</div>\n";
};

// A scheme, or `//host`: another origin.
const LEAVES = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
export const LEAVES_DOCUMENT = ' target="_blank" rel="noopener noreferrer"';

/** A link with a scheme, or to `//host`, leaves the document: new tab, no
 * opener, no referrer (the referrer would be this page's URL). */
const externalLinks: PluginSimple = (md) => {
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token && LEAVES.test(String(token.attrGet("href") ?? ""))) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
    }
    return self.renderToken(tokens, idx, options);
  };
};

const EMBEDDED_RASTER = /^data:image\/(png|jpeg|gif|webp);/i;

const ATTACHMENT = "attachment:";

/** An attached image's identifier (D-40): `""` for a source of the scheme
 * whose identifier is not of W-53, which cites nothing; `null` for any
 * other source. The editor's rule too. */
export function attachmentOf(src: string): string | null {
  if (!src.startsWith(ATTACHMENT)) return null;
  const id = src.slice(ATTACHMENT.length);
  return isAttachmentId(id) ? id : "";
}

/** Whether an image's source is shown rather than linked (ADR-0021 §5):
 * the preview's rule, for the editor's images too. */
export function isEmbeddedRaster(src: string): boolean {
  return EMBEDDED_RASTER.test(src);
}

/** Whether the remote image at this address, as `loadableImageSource`
 * normalizes it, is loaded (ADR-0055 §3, §4): granted, and not under a
 * cursor — `lines`, the source lines of its block and of any definition
 * of its address, each `[first, after last)` from 0 (§12). */
export type GrantedImage = (
  src: string,
  lines: readonly (readonly [number, number])[],
) => boolean;

const NONE_GRANTED: GrantedImage = () => false;

/** An embedded raster image is shown; a remote one the page may load, only
 * once granted, without a referrer, else a case around its link that the
 * view fills (ADR-0055 §3, §8); any other becomes a link, so a reader
 * loads nothing an author chose without their consent (ADR-0021 §5). */
type BlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

const imagesAsLinks: PluginSimple = (md) => {
  // A definition's lines, by its address (ADR-0055 §12): an image by
  // reference is written there too. markdown-it keeps its address only.
  const reference = (
    md.block.ruler as unknown as {
      __rules__: { name: string; fn: BlockRule }[];
    }
  ).__rules__.find((rule) => rule.name === "reference")?.fn;
  if (reference) {
    md.block.ruler.at("reference", (state, startLine, endLine, silent) => {
      const env = state.env as {
        references?: Record<string, { href: string }>;
        definitions?: { href: string; lines: [number, number] }[];
      };
      const before = new Set(Object.keys(env.references ?? {}));
      if (!reference(state, startLine, endLine, silent)) return false;
      for (const [label, { href }] of Object.entries(env.references ?? {})) {
        if (before.has(label)) continue;
        env.definitions ??= [];
        env.definitions.push({ href, lines: [startLine, state.line] });
      }
      return true;
    });
  }
  // An image's own place is not kept by markdown-it: its block's lines,
  // or for a table's cell (no lines of its own), its row's; and those of
  // a definition of its address.
  md.core.ruler.push("image_lines", (state) => {
    const definitions =
      (
        state.env as {
          definitions?: { href: string; lines: [number, number] }[];
        }
      ).definitions ?? [];
    let block: [number, number] | null = null;
    for (const token of state.tokens) {
      block = token.map ?? block;
      if (token.type !== "inline" || !block) continue;
      for (const child of token.children ?? []) {
        if (child.type !== "image") continue;
        const src = child.attrGet("src");
        const lines = [
          block,
          ...definitions
            .filter((definition) => definition.href === src)
            .map((definition) => definition.lines),
        ];
        child.meta = { ...child.meta, lines };
      }
    }
  });
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = String(token?.attrGet("src") ?? "");
    const alt = self.renderInlineAsText(token?.children ?? [], options, env);
    if (EMBEDDED_RASTER.test(src)) {
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
    }
    const attached = attachmentOf(src);
    if (attached !== null) {
      // Its text until the view fills it (ADR-0057 §8); an identifier not
      // of W-53 cites nothing, and the view says so (D-40).
      return `<span class="attached-image" data-attachment="${attached}"><span class="attached-image-text">${escapeHtml(alt)}</span></span>`;
    }
    const target = LEAVES.test(src) ? LEAVES_DOCUMENT : "";
    const link = `<a class="remote-image" href="${escapeHtml(src)}"${target}>${escapeHtml(alt || src)}</a>`;
    const loadable = loadableImageSource(src);
    if (loadable === null) return link;
    const granted =
      (env as { grantedImage?: GrantedImage } | undefined)?.grantedImage ??
      NONE_GRANTED;
    if (
      granted(
        loadable,
        (token?.meta?.lines ?? []) as readonly (readonly [number, number])[],
      )
    ) {
      // Its domain under it, filled by the view (§13).
      return `<span class="remote-image-shown"><img src="${escapeHtml(loadable)}" alt="${escapeHtml(alt)}" referrerpolicy="no-referrer"></span>`;
    }
    return `<span class="remote-image-case" data-image-source="${escapeHtml(loadable)}">${link}</span>`;
  };
};

/** Obsidian's `[[…]]`, before links and footnotes,
 * as `readWikilink` reads it — the editor's parser too: a heading of this
 * document, a link to it (the view finds it, `goToAnchor`); a block or a
 * note of someone's vault, shown, not a link (the view says so). */
const wikilinks: PluginSimple = (md) => {
  md.inline.ruler.before("link", "wikilink", (state: StateInline, silent) => {
    const found = readWikilink(state.src, state.pos);
    if (!found || found.end > state.posMax) return false;
    if (!silent) {
      const token = state.push("wikilink", "", 0);
      token.meta = { wikilink: found };
    }
    state.pos = found.end;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx) => {
    const found = tokens[idx]?.meta?.wikilink as Wikilink;
    const shown = escapeHtml(found.shown);
    if (found.kind === "heading") {
      const href = `#${encodeURIComponent(found.path.join("#"))}`;
      return `<a class="md-wikilink" href="${href}">${shown}</a>`;
    }
    return `<span class="md-wikilink md-wikilink-local" data-wikilink="${found.kind}">${shown}</span>`;
  };
};

const md = new MarkdownIt("commonmark", { html: false })
  .enable(["table", "strikethrough"])
  .use(frontMatter)
  .use(footnotes)
  .use(highlights)
  .use(wikilinks)
  .use(taskLists)
  .use(lazyTables)
  .use(callouts)
  .use(mathPlaceholders)
  .use(mermaidPlaceholders)
  .use(externalLinks)
  .use(imagesAsLinks);

/** Where a link's address leaves the document, as the preview renders it
 * (normalized, and checked by markdown-it, which refuses `javascript:`,
 * `vbscript:`, `file:` and `data:`), or null: refused, or inside the
 * document. For the editor's Ctrl/Cmd+click. */
export function leavingHref(href: string): string | null {
  const url = md.normalizeLink(href.trim());
  return md.validateLink(url) && LEAVES.test(url) ? url : null;
}

export function renderMarkdown(
  source: string,
  grantedImage: GrantedImage = NONE_GRANTED,
): RenderedHtml {
  return markdownItHtml(md.render(source, { grantedImage }));
}

/** Whether `text` may hold an image to an https address: without both,
 * it is not parsed (most texts, at each burst). */
const MAY_HOLD_REMOTE_IMAGE = (text: string) =>
  text.includes("![") && /https:/i.test(text);

/** The remote images of `text` the page may load (`loadableImageSource`),
 * each once, in the text's order: what the banner counts (ADR-0055 §4). */
export function remoteImageSources(text: string): string[] {
  if (!MAY_HOLD_REMOTE_IMAGE(text)) return [];
  count("images.scan");
  const found = new Set<string>();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "image") {
        const loadable = loadableImageSource(
          String(token.attrGet("src") ?? ""),
        );
        if (loadable !== null) found.add(loadable);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(md.parse(text, {}));
  return [...found];
}

/** The same HTML as `renderMarkdown`, and, for each top-level block it
 * holds (in order, the footnotes' section aside), its source lines —
 * `[first, after last)`, from 0 — from the same parse. Kept out of the
 * HTML: the preview matches kept blocks by their HTML, and a line number
 * in it would change every block below an edit. */
export function renderMarkdownBlocks(
  source: string,
  grantedImage: GrantedImage = NONE_GRANTED,
): {
  html: RenderedHtml;
  lines: [number, number][];
} {
  const env = { grantedImage };
  const tokens = md.parse(source, env);
  const lines: [number, number][] = [];
  for (const token of tokens) {
    if (token.level !== 0 || !token.block || !token.map) continue;
    if (token.nesting === 1 || token.nesting === 0) {
      lines.push([token.map[0], token.map[1]]);
    }
  }
  return {
    html: markdownItHtml(md.renderer.render(tokens, md.options, env)),
    lines,
  };
}
