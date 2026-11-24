import { syntaxTree } from "@codemirror/language";
import { Facet, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { t } from "../i18n/index.js";
import { count, span } from "../perf/index.js";
import {
  type CalloutFamily,
  attachmentOf,
  defaultCalloutTitle,
  highlightColor,
  isEmbeddedRaster,
  loadableImageSource,
  readWikilink,
} from "../render/index.js";
import type { AttachedImages } from "../view-model/attached-images.js";
import type { RemoteImages } from "../view-model/remote-images.js";
import { calloutOf } from "./callout-node.js";
import { type Reveal, liveReveal, revealsBetween } from "./live-reveal.js";
import {
  AttachedImageWidget,
  BulletWidget,
  CalloutHeaderWidget,
  ImageCaseWidget,
  ImageWidget,
  MathWidget,
  TaskWidget,
  attachedImagesFacet,
} from "./live-widgets.js";
import { remoteImageGrants } from "./remote-image-grants.js";

/** What live formatting does to a range: hides
 * markup, replaces it with a widget (a list's dot, a task's box), marks
 * text with a class, or classes a whole line (`from` is its start). The
 * text's styles are the highlighter's (markdown-syntax.ts). */
export interface LiveSpec {
  kind: "hide" | "widget" | "mark" | "line";
  from: number;
  to: number;
  className?: string;
  widget?:
    | "bullet"
    | "task"
    | "math"
    | "image"
    | "image-case"
    | "attached-image"
    | "callout-header";
  /** A formula's TeX, an image's source, a callout's default title (empty
   * when it has its own). */
  source?: string;
  /** A callout's family: its icon. */
  family?: CalloutFamily;
  /** A formula shown on its own (`$$`). */
  display?: boolean;
  /** An image's text. */
  alt?: string;
  /** A remote image, granted (ADR-0055 §6). */
  remote?: boolean;
  /** A line's inline style (a list item's depth). */
  style?: string;
  /** A task's box. */
  checked?: boolean;
  /** For a screen reader, what the hidden markup said: a
   * heading's role and level, a quote's, a link's. */
  attributes?: Record<string, string>;
}

/** The decorations of the formatted text, from the syntax tree, for the
 * part on screen only. Markup is hidden unless a selection range touches
 * one of its lines (decision 3: per line; an empty range touches its
 * caret's line). What stays visible of a line is what the preview shows of
 * it. The lines of `reveal`'s active passage are revealed too, and those
 * of any other range all of which would be hidden (a point strictly
 * inside hidden markup): what other layers draw there stays in sight
 *. Pure: the plugin turns the specs into decorations. Sorted
 * by `from`. */
export function livePreview(
  tree: Tree,
  doc: Text,
  selection: readonly { from: number; to: number }[],
  visibleRanges: readonly { from: number; to: number }[],
  reveal: readonly Reveal[] = [],
  /** The reader's grants of remote images (ADR-0055 §6); default: none,
   * and no case. */
  images?: ImageGrants,
): LiveSpec[] {
  count("live.build");
  const { specs, nodes } = liveSpecs(
    tree,
    doc,
    selection,
    visibleRanges,
    reveal,
    images,
  );
  count("live.node", nodes);
  return specs;
}

/** Whether the text is formatted, not its source: given with
 * the formatting's extensions, for what reads it from the state (the
 * first hints, ADR-0064 AC4). */
export const formattedText = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/** Whether the formatted text hides markup in `[from, to)`, nothing
 * selected there: what a caret on it shows again (ADR-0064, AC4). */
export function hidesMarkup(
  tree: Tree,
  doc: Text,
  from: number,
  to: number,
): boolean {
  const { specs } = liveSpecs(tree, doc, [], [{ from, to }]);
  return specs.some(
    (spec) =>
      (spec.kind === "hide" || spec.kind === "widget") &&
      spec.from < Math.max(to, from + 1) &&
      spec.to >= from,
  );
}

/** What the formatted text shows of `[from, to)`, nothing selected: the
 * text, its markup hidden, a formula its TeX, a drawn image or a list's
 * marker nothing — what the preview shows of it (the property of
 * `livePreview`). For the outline: not the editor's work, so
 * not counted as such. */
export function visibleText(
  tree: Tree,
  doc: Text,
  from: number,
  to: number,
): string {
  const { specs } = liveSpecs(tree, doc, [], [{ from, to }]);
  let out = "";
  let at = from;
  for (const spec of specs) {
    if (spec.kind !== "hide" && spec.kind !== "widget") continue;
    if (spec.to <= from || spec.from >= to) continue;
    out += doc.sliceString(at, Math.max(at, spec.from));
    if (spec.widget === "math" && spec.from >= at) out += spec.source ?? "";
    at = Math.max(at, Math.min(spec.to, to));
  }
  return out + doc.sliceString(at, Math.max(at, to));
}

function liveSpecs(
  tree: Tree,
  doc: Text,
  selection: readonly { from: number; to: number }[],
  visibleRanges: readonly { from: number; to: number }[],
  reveal: readonly Reveal[] = [],
  images?: ImageGrants,
): { specs: LiveSpec[]; nodes: number } {
  let nodes = 0;
  const always = reveal.filter((range) => range.kind === "active");
  const touched = [...selection, ...always].map((range) => [
    doc.lineAt(range.from).number,
    doc.lineAt(range.to).number,
  ]);
  const lineTouched = (n: number): boolean =>
    touched.some(
      ([start, end]) => (start as number) <= n && n <= (end as number),
    );
  const revealed = (node: SyntaxNode): boolean => {
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(node.to).number;
    return touched.some(
      ([start, end]) => (start as number) <= last && first <= (end as number),
    );
  };
  const specs: LiveSpec[] = [];
  const seen = new Set<string>();
  // The last callout's header hidden: what the walk finds inside (the
  // type's own markup) is hidden with it, never twice. The last one only:
  // the walk goes in the text's order, and reads a callout's header before
  // anything in it — before any callout inside. All of them, looked up at
  // each node, cost the number of callouts each time.
  let header: [number, number] | undefined;
  const add = (spec: LiveSpec): void => {
    // Empty, only a line or the one widget put between characters.
    const point = spec.kind === "line" || spec.widget === "image-case";
    if (spec.to < spec.from || (!point && spec.to === spec.from)) return;
    if (
      spec.kind !== "line" &&
      header &&
      header[0] <= spec.from &&
      spec.to <= header[1] &&
      (header[0] !== spec.from || header[1] !== spec.to)
    )
      return;
    const key = `${spec.kind}:${spec.from}:${spec.to}:${spec.className ?? ""}:${spec.style ?? ""}`;
    if (seen.has(key)) return; // a node spanning two visible ranges
    seen.add(key);
    specs.push(spec);
  };
  /** Line by line: a plugin may not replace a line break, and markup may
   * span one (`[t](` then the address on the next line). */
  /** The part on screen being walked: a block only decorates its lines
   * there, however long it is. */
  let range = { from: 0, to: 0 };
  /** Classes each line of `[from, to]` on screen; `edge` for its first and
   * last lines (a code block's fences). */
  const eachLine = (
    from: number,
    to: number,
    className: string,
    edge?: string,
    attributes?: (n: number) => Record<string, string> | undefined,
  ): void => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const start = Math.max(first, doc.lineAt(range.from).number);
    const end = Math.min(last, doc.lineAt(range.to).number);
    for (let n = start; n <= end; n++) {
      const line = doc.line(n);
      const atEdge = edge && (n === first || n === last);
      const said = attributes?.(n);
      add({
        kind: "line",
        from: line.from,
        to: line.from,
        className: atEdge ? `${className} ${edge}` : className,
        ...(said && { attributes: said }),
      });
    }
  };
  const hide = (from: number, to: number): void => {
    for (let at = from; at < to; ) {
      const line = doc.lineAt(at);
      add({ kind: "hide", from: at, to: Math.min(to, line.to) });
      at = line.to + 1;
    }
  };

  /** Decorates one node; true when the walk should go into its children
   * (the nodes that place their own children return false). */
  const visit = (node: SyntaxNode): boolean => {
    nodes++;
    switch (node.name) {
      case "EmphasisMark":
      case "StrikethroughMark":
        if (!revealed(node)) hide(node.from, node.to);
        return false;
      case "InlineCode":
        if (!revealed(node)) code(node);
        return false;
      case "Escape":
        if (!revealed(node)) hide(node.from, node.from + 1);
        return false;
      case "HardBreak":
        // A backslash's, not two spaces' (unseen anyway).
        if (
          !revealed(node) &&
          doc.sliceString(node.from, node.from + 1) === "\\"
        )
          hide(node.from, node.from + 1);
        return false;
      case "Highlight":
        highlight(node);
        return false;
      case "Link":
        link(node);
        return false;
      case "Wikilink":
        wikilink(node);
        return false;
      case "Autolink":
        autolink(node);
        return false;
      case "InlineMath":
      case "DisplayMath":
        formula(node);
        return false;
      case "Image":
        image(node);
        return false;
      case "ListMark":
        listMark(node);
        return false;
      case "TaskMarker":
        if (!revealed(node)) {
          add({
            kind: "widget",
            from: node.from,
            // The box takes its space in: it is the item's marker.
            to: spaceAfter(node.to),
            widget: "task",
            checked: doc.sliceString(node.from + 1, node.from + 2) !== " ",
          });
        }
        return false;
      case "ListItem":
        listItem(node);
        return true;
      case "Blockquote":
        quote(node);
        return true;
      case "QuoteMark":
        if (!revealed(node)) hide(node.from, spaceAfter(node.to));
        return false;
      case "HorizontalRule":
        eachLine(node.from, node.to, "cm-live-hr");
        if (!revealed(node)) hide(node.from, node.to);
        return false;
      case "FencedCode":
        eachLine(node.from, node.to, "cm-live-codeblock", "cm-live-fence");
        quoteMarks(node);
        return false;
      case "CodeBlock":
        eachLine(node.from, node.to, "cm-live-codeblock");
        quoteMarks(node);
        return false;
    }
    const setext = /^SetextHeading(\d)$/.exec(node.name)?.[1];
    if (setext) {
      setextHeading(node, setext);
      return false;
    }
    const level = /^ATXHeading(\d)$/.exec(node.name)?.[1];
    if (level) {
      heading(node, level);
      return false;
    }
    return true;
  };
  const walk = (node: SyntaxNode): void => {
    if (!visit(node)) return;
    for (let child = node.firstChild; child; child = child.nextSibling)
      walk(child);
  };

  /** A quote's lines, or a callout's: its colour,
   * its title line, its header hidden, a default title in its place. A
   * line is in the frame of its innermost callout: the lines of the
   * callouts inside are theirs; a plain quote inside adds its rule. */
  function quote(node: SyntaxNode): void {
    const callout = calloutOf(node, doc);
    const inner = innerCallouts(node);
    const first = doc.lineAt(node.from).number;
    const start = Math.max(first, doc.lineAt(range.from).number);
    const end = Math.min(
      doc.lineAt(node.to).number,
      doc.lineAt(range.to).number,
    );
    const attributes = {
      role: "group",
      "aria-roledescription": callout ? t().callout : t().quote,
    };
    const titleLine = callout && doc.lineAt(callout.from).number;
    for (let n = start; n <= end; n++) {
      if (inner.some(([a, b]) => a <= n && n <= b)) continue;
      add({
        kind: "line",
        from: doc.line(n).from,
        to: doc.line(n).from,
        className: !callout
          ? "cm-live-quote"
          : n === titleLine
            ? "cm-live-callout cm-live-callout-title"
            : "cm-live-callout",
        attributes,
        ...(callout && {
          style: `--md-callout-color: var(--md-callout-${callout.header.family})`,
        }),
      });
    }
    if (!callout || !titleLine) return;
    const line = doc.line(titleLine);
    if (lineTouched(titleLine)) return;
    const from = line.from + callout.header.at;
    const markup = /^\[![^\]]*\][+-]?[ \t]*/.exec(
      line.text.slice(callout.header.at),
    );
    const to = from + (markup?.[0].length ?? 0);
    add({
      kind: "widget",
      from,
      to,
      widget: "callout-header",
      family: callout.header.family,
      source: callout.header.title
        ? ""
        : defaultCalloutTitle(callout.header.type),
    });
    header = [from, to];
  }

  /** The lines of the callouts inside a quote, at any depth (in its
   * lists, its quotes). */
  function innerCallouts(node: SyntaxNode): [number, number][] {
    const found: [number, number][] = [];
    const down = (parent: SyntaxNode): void => {
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.name === "Blockquote" && calloutOf(child, doc)) {
          found.push([
            doc.lineAt(child.from).number,
            doc.lineAt(child.to).number,
          ]);
        } else if (
          /^(Blockquote|BulletList|OrderedList|ListItem)$/.test(child.name)
        ) {
          down(child);
        }
      }
    };
    down(node);
    return found;
  }

  /** Its backticks, and one space each side when there is one each side
   * and the code is not all spaces (CommonMark). */
  function code(node: SyntaxNode): void {
    const marks = node.getChildren("CodeMark");
    const open = marks[0];
    const close = marks[marks.length - 1];
    if (!open || !close || open === close) return;
    const inside = doc.sliceString(open.to, close.from);
    const trim = inside.length >= 2 && /^ .*[^ ].* $/s.test(inside) ? 1 : 0;
    hide(open.from, open.to + trim);
    hide(close.from - trim, close.to);
  }

  /** Whether `node` crosses a line break: a plugin may not replace it. */
  function multiline(node: SyntaxNode): boolean {
    return doc.lineAt(node.from).number !== doc.lineAt(node.to).number;
  }

  /** A formula becomes its rendering, unless its line is
   * touched; one over a line break stays its source. */
  function formula(node: SyntaxNode): void {
    if (revealed(node) || multiline(node)) return;
    const marks = node.getChildren("MathMark");
    const open = marks[0];
    const close = marks[1];
    if (!open || !close) return;
    add({
      kind: "widget",
      from: node.from,
      to: node.to,
      widget: "math",
      source: doc.sliceString(open.to, close.from),
      display: node.name === "DisplayMath",
    });
  }

  /** An embedded raster image is drawn (on one line: a plugin may not
   * replace a line break), and a remote one granted, never one the page
   * may not load (ADR-0055 §2, §11); any other is its text, as a link, as
   * in the preview (ADR-0021 §5); with no text, it stays as written. */
  function image(node: SyntaxNode): void {
    const marks = node.getChildren("LinkMark");
    const open = marks[0];
    const close = marks[1];
    const url = node.getChild("URL");
    // A reference image, `![x]`: as a reference link, its brackets kept,
    // its text formatted (found by the visible-text property).
    if (!open || !close || !url) {
      for (let child = node.firstChild; child; child = child.nextSibling)
        walk(child);
      return;
    }
    if (revealed(node)) return;
    const src = doc.sliceString(url.from, url.to).replace(/^<(.*)>$/, "$1");
    const alt = doc.sliceString(open.to, close.from);
    const remote = images && !multiline(node) ? loadableImageSource(src) : null;
    const attached = attachmentOf(src);
    if (attached !== null && !multiline(node)) {
      // The document's own (ADR-0057 §8): the view draws it, or says why
      // it can't.
      add({
        kind: "widget",
        from: node.from,
        to: node.to,
        widget: "attached-image",
        source: attached,
        alt,
      });
    } else if (isEmbeddedRaster(src) && !multiline(node)) {
      add({
        kind: "widget",
        from: node.from,
        to: node.to,
        widget: "image",
        source: src,
        alt,
      });
    } else if (remote !== null && images?.granted(remote)) {
      add({
        kind: "widget",
        from: node.from,
        to: node.to,
        widget: "image",
        source: remote,
        alt,
        remote: true,
      });
    } else if (alt.trim() !== "") {
      hide(open.from, open.to);
      hide(close.from, node.to);
      add({
        kind: "mark",
        from: open.to,
        to: close.from,
        className: "cm-live-link",
      });
    }
    // Not granted: its domain and a button after it, as in the preview
    // (ADR-0055 §3, §6); failed, its link alone (§8).
    if (
      remote !== null &&
      !images?.granted(remote) &&
      !images?.failed(remote)
    ) {
      add({
        kind: "widget",
        from: node.to,
        to: node.to,
        widget: "image-case",
        source: remote,
      });
    }
  }

  /** The quote markers on a code block's lines, hidden as on any quoted
   * line (11e.1b): its code is not walked. */
  function quoteMarks(node: SyntaxNode): void {
    for (const mark of node.getChildren("QuoteMark")) visit(mark);
  }

  /** One space after `at`, if there is one on its line. */
  function spaceAfter(at: number): number {
    return doc.sliceString(at, at + 1) === " " ? at + 1 : at;
  }

  /** A bullet becomes a dot, its space with it; a task's bullet goes, its
   * box is enough; a number stays, in a marker of its own. Each is the
   * width the item's text hangs from. */
  function listMark(node: SyntaxNode): void {
    if (revealed(node)) return;
    const end = spaceAfter(node.to);
    if (!/^[-*+]$/.test(doc.sliceString(node.from, node.to))) {
      add({ kind: "mark", from: node.from, to: end, className: "cm-live-num" });
    } else if (node.parent?.getChild("Task")) {
      hide(node.from, end);
    } else {
      add({ kind: "widget", from: node.from, to: end, widget: "bullet" });
    }
  }

  /** A list item hangs under its text: its first line from its marker, its
   * other lines (continued or lazy) under its text, both by the item's
   * depth; the spaces that indent them in the source are hidden. A line
   * the selection touches stays its source. Its sublists' lines are
   * theirs. */
  function listItem(node: SyntaxNode): void {
    let depth = -1;
    for (let up: SyntaxNode | null = node; up; up = up.parent)
      if (up.name === "BulletList" || up.name === "OrderedList") depth++;
    const style = `--li-depth: ${depth}`;
    const sublists: [number, number][] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "BulletList" || child.name === "OrderedList")
        sublists.push([
          doc.lineAt(child.from).number,
          doc.lineAt(child.to).number,
        ]);
    }
    const first = doc.lineAt(node.from).number;
    const start = Math.max(first, doc.lineAt(range.from).number);
    const end = Math.min(
      doc.lineAt(node.to).number,
      doc.lineAt(range.to).number,
    );
    for (let n = start; n <= end; n++) {
      if (sublists.some(([a, b]) => a <= n && n <= b)) continue;
      const line = doc.line(n);
      if (line.length === 0) continue;
      if (lineTouched(n)) {
        // Its source, nothing hidden; its indentation as wide as the
        // depth's, so its marker stands where the line's bullet does,
        // by tabs or spaces (ADR-0054).
        const quote = /^([ \t]*>[ \t]?)*/.exec(line.text)?.[0].length ?? 0;
        const indent = /^[ \t]*/.exec(line.text.slice(quote))?.[0].length ?? 0;
        if (indent > 0 && (depth > 0 || n !== first)) {
          add({
            kind: "mark",
            from: line.from + quote,
            to: line.from + quote + indent,
            className:
              n === first ? "cm-live-li-indent" : "cm-live-li-indent-cont",
            attributes: { style },
          });
        }
        continue;
      }
      add({
        kind: "line",
        from: line.from,
        to: line.from,
        className: n === first ? "cm-live-li" : "cm-live-li-cont",
        style,
      });
      // After the quote markers, hidden as such, the spaces that indent
      // the item in the source.
      const quote = /^([ \t]*>[ \t]?)*/.exec(line.text)?.[0].length ?? 0;
      const indent = /^[ \t]*/.exec(line.text.slice(quote))?.[0].length ?? 0;
      hide(line.from + quote, line.from + quote + indent);
    }
  }

  /** Its text's lines as a heading; its underline, a whole line of markup,
   * dimmed (a plugin cannot take a line away). */
  function setextHeading(node: SyntaxNode, level: string): void {
    const underline = node.getChild("HeaderMark");
    const textEnd = underline ? underline.from - 1 : node.to;
    // A heading over several lines is one: its role on its first.
    eachLine(node.from, textEnd, `cm-live-h${level}`, undefined, (n) =>
      n === doc.lineAt(node.from).number ? headingRole(level) : undefined,
    );
    if (underline)
      eachLine(underline.from, underline.to, "cm-live-markup-line");
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.name !== "HeaderMark") walk(child);
  }

  /** Obsidian's `[[…]]`: what the preview shows
   * of it, its alias or its target without a leading `#`; a heading of
   * this document a link, anything else marked as not shared. */
  function wikilink(node: SyntaxNode): void {
    const target = node.getChild("WikilinkTarget");
    if (!target) return;
    const alias = node.getChild("WikilinkAlias");
    let from = alias?.from ?? target.from;
    const to = alias?.to ?? target.to;
    if (!alias && doc.sliceString(from, from + 1) === "#") from += 1;
    if (!revealed(node)) {
      hide(node.from, from);
      hide(to, node.to);
    }
    const kind = readWikilink(doc.sliceString(node.from, node.to), 0)?.kind;
    add(
      kind === "heading"
        ? {
            kind: "mark",
            from,
            to,
            className: "cm-live-link",
            attributes: LINK,
          }
        : {
            kind: "mark",
            from,
            to,
            className: "cm-live-link cm-live-wikilink-local",
            attributes: { title: t().wikilinkLocal },
          },
    );
  }

  function link(node: SyntaxNode): void {
    const marks = node.getChildren("LinkMark");
    const open = marks[0];
    const close = marks[1];
    // Inline links only: a reference link keeps its brackets, its text
    // is formatted.
    if (!open || !close || !node.getChild("URL")) {
      for (let child = node.firstChild; child; child = child.nextSibling)
        walk(child);
      return;
    }
    if (!revealed(node)) {
      hide(open.from, open.to);
      hide(close.from, node.to);
    }
    add({
      kind: "mark",
      from: open.to,
      to: close.from,
      className: "cm-live-link",
      attributes: LINK,
    });
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.from >= open.to && child.to <= close.from) walk(child);
  }

  /** A highlight (ADR-0044): its marks hidden, and a color's emoji right
   * after the opening; its text marked with that color, revealed or not
   * (the default color is the highlighter's). */
  function highlight(node: SyntaxNode): void {
    const open = node.firstChild;
    const close = node.lastChild;
    if (open?.name !== "HighlightMark" || close?.name !== "HighlightMark")
      return;
    const color = open.nextSibling;
    const colored =
      color?.name === "HighlightColor" && color.from === open.to
        ? highlightColor(doc.sliceString(color.from, color.to))
        : undefined;
    const start = colored && color ? color.to : open.to;
    if (!revealed(node)) {
      hide(node.from, start);
      hide(close.from, node.to);
    }
    if (colored) {
      add({
        kind: "mark",
        from: start,
        to: close.from,
        className: `cm-md-highlight-${colored.color}`,
      });
    }
    for (
      let child = open.nextSibling;
      child && child !== close;
      child = child.nextSibling
    )
      if (child.name !== "HighlightColor") walk(child);
  }

  function autolink(node: SyntaxNode): void {
    const url = node.getChild("URL");
    if (!url) return;
    if (!revealed(node)) {
      hide(node.from, url.from);
      hide(url.to, node.to);
    }
    add({
      kind: "mark",
      from: url.from,
      to: url.to,
      className: "cm-live-link",
      attributes: LINK,
    });
  }

  function heading(node: SyntaxNode, level: string): void {
    const line = doc.lineAt(node.from);
    add({
      kind: "line",
      from: line.from,
      to: line.from,
      className: `cm-live-h${level}`,
      attributes: headingRole(level),
    });
    const shown = revealed(node);
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== "HeaderMark") {
        walk(child);
      } else if (shown) {
        nodes++;
      } else if (child.from === node.from) {
        // The opening marks and the spaces after them.
        let end = child.to;
        while (end < line.to && doc.sliceString(end, end + 1) === " ") end++;
        hide(child.from, end);
      } else {
        // A closing sequence and the spaces before it.
        let start = child.from;
        while (start > node.from && doc.sliceString(start - 1, start) === " ")
          start--;
        hide(start, child.to);
      }
    }
  }

  const pass = (): void => {
    specs.length = 0;
    seen.clear();
    for (range of visibleRanges) {
      tree.iterate({
        from: range.from,
        to: range.to,
        enter: (ref) => visit(ref.node),
      });
    }
    specs.sort((a, b) => a.from - b.from || order(a) - order(b) || a.to - b.to);
  };
  pass();
  const lost = hiddenAway(
    specs,
    reveal.filter(
      (range) =>
        range.kind !== "active" &&
        visibleRanges.some(
          (visible) => visible.from <= range.to && range.from <= visible.to,
        ),
    ),
  );
  if (lost.length > 0) {
    for (const range of lost)
      touched.push([
        doc.lineAt(range.from).number,
        doc.lineAt(range.to).number,
      ]);
    pass();
  }
  return { specs, nodes };
}

/** The ranges of `ranges` that `specs` (sorted) would take out of sight:
 * a point strictly inside hidden or replaced text, a range all of it. */
function hiddenAway(
  specs: readonly LiveSpec[],
  ranges: readonly Reveal[],
): Reveal[] {
  if (ranges.length === 0) return [];
  const hiders = specs.filter(
    (spec) => spec.kind === "hide" || spec.kind === "widget",
  );
  return ranges.filter((range) => {
    if (range.from === range.to)
      return hiders.some((h) => h.from < range.from && range.from < h.to);
    let covered = range.from;
    for (const h of hiders) {
      if (h.from > covered) break;
      if (h.to > covered) covered = h.to;
      if (covered >= range.to) return true;
    }
    return false;
  });
}

const LINK = { role: "link" };

/** A heading's role, for a screen reader: its line, by level. */
function headingRole(level: string): Record<string, string> {
  return { role: "heading", "aria-level": level };
}

/** Line decorations first at a position, then replaced ranges, then
 * marks. */
function order(spec: LiveSpec): number {
  return spec.kind === "line" ? 0 : spec.kind === "mark" ? 2 : 1;
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const boxes = [false, true].map((checked) =>
  Decoration.replace({ widget: new TaskWidget(checked) }),
);
const taskBox = (checked: boolean) => boxes[checked ? 1 : 0] as Decoration;

/** What the formatted text asks of the reader's grants (ADR-0055 §6). */
export interface ImageGrants {
  granted(src: string): boolean;
  failed(src: string): boolean;
}

function widgetOf(
  spec: LiveSpec,
  images?: Pick<RemoteImages, "grantImage" | "markFailed">,
  attached?: AttachedImages,
): Decoration {
  switch (spec.widget) {
    case "image-case":
      return Decoration.widget({
        widget: new ImageCaseWidget(spec.source ?? "", (src) =>
          images?.grantImage(src),
        ),
        side: 1,
      });
    case "task":
      return taskBox(spec.checked ?? false);
    case "math":
      return Decoration.replace({
        widget: new MathWidget(spec.source ?? "", spec.display ?? false),
      });
    case "image":
      return Decoration.replace({
        widget: new ImageWidget(
          spec.source ?? "",
          spec.alt ?? "",
          spec.remote ? (src) => images?.markFailed(src) : undefined,
        ),
      });
    case "attached-image":
      return Decoration.replace({
        widget: new AttachedImageWidget(
          spec.source ?? "",
          spec.alt ?? "",
          attached,
        ),
      });
    case "callout-header":
      return Decoration.replace({
        widget: new CalloutHeaderWidget(
          spec.family ?? "note",
          spec.source ?? "",
        ),
      });
    default:
      return bullet;
  }
}

function decorate(view: EditorView): DecorationSet {
  // Without focus, nothing is revealed: on opening, the caret at the start
  // would show the title's `# `.
  const selection = view.hasFocus ? view.state.selection.ranges : [];
  const images = remoteImageGrants(view.state)?.images;
  const attached = view.state.facet(attachedImagesFacet);
  // Measured with `?perf`: `oc:live`.
  const specs = span("live", () =>
    livePreview(
      syntaxTree(view.state),
      view.state.doc,
      selection,
      view.visibleRanges,
      view.visibleRanges.flatMap((range) =>
        revealsBetween(view.state.facet(liveReveal), range.from, range.to),
      ),
      images,
    ),
  );
  return Decoration.set(
    specs.map((spec) => {
      switch (spec.kind) {
        case "hide":
          return hidden.range(spec.from, spec.to);
        case "widget":
          return widgetOf(spec, images, attached).range(spec.from, spec.to);
        case "line":
          return Decoration.line({
            class: spec.className ?? "",
            ...((spec.style || spec.attributes) && {
              attributes: {
                ...spec.attributes,
                ...(spec.style && { style: spec.style }),
              },
            }),
          }).range(spec.from);
        case "mark":
          return Decoration.mark({
            class: spec.className ?? "",
            ...(spec.attributes && { attributes: spec.attributes }),
          }).range(spec.from, spec.to);
      }
    }),
    true,
  );
}

/** The formatted text in the editor: recomputed on the part on
 * screen when the text, the selection, the focus, the part on screen, what
 * other layers keep in sight (`liveReveal`) or the syntax tree change.
 * During a composition (IME) the revealed lines stay as they were: the
 * decorations only follow the text. */
export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate): void {
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
      } else if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        update.startState.facet(liveReveal) !==
          update.state.facet(liveReveal) ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        remoteImageGrants(update.startState) !==
          remoteImageGrants(update.state) ||
        update.startState.facet(attachedImagesFacet) !==
          update.state.facet(attachedImagesFacet)
      ) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The formatted text's own classes, inside the editor (page rules lose to
 * CodeMirror's base theme): a link's text underlined, its address hidden;
 * the headings' look is the page's (`page-only.css`). */
export const livePreviewTheme = EditorView.theme({
  ".cm-live-link": { color: "var(--pencil)", textDecoration: "underline" },
  // An autolink's address is highlighted as an address; here, a link.
  ".cm-live-link .cm-md-url": { color: "inherit" },
  // A [[…]] to a note or a block: not a link, as the preview.
  ".cm-live-wikilink-local": {
    color: "var(--muted)",
    textDecoration: "underline dotted",
    cursor: "help",
  },
  ".cm-live-wikilink-local .cm-md-link": { color: "inherit" },
  ".cm-live-markup-line": { color: "var(--muted)", fontSize: "0.8em" },
  // `.cm-line` to win over the page theme's padding of every line.
  ".cm-line.cm-live-quote": {
    "--quote-pad": "0.8em",
    borderLeft: "3px solid var(--rule)",
    paddingLeft: "0.8em",
    color: "var(--muted)",
  },
  // A callout: its family's colour (a
  // token of `page.css`), a tinted background, no rule; its title and icon
  // in its colour. A plain quote inside draws its rule over it. Its tint
  // a variable: a code block's line draws it under its own.
  ".cm-line.cm-live-callout": {
    "--quote-pad": "0.8em",
    "--md-callout": "var(--md-callout-color, var(--md-callout-note))",
    "--md-callout-tint":
      "color-mix(in srgb, var(--md-callout) 10%, transparent)",
    background: "var(--md-callout-tint)",
    paddingLeft: "0.8em",
  },
  // Its own colour, unless the plugin writes it in the text's (essai
  // 15e.2); its icon always in the family's.
  ".cm-live-callout-title": {
    color: "var(--md-callout-title, var(--md-callout))",
    fontWeight: "600",
  },
  ".cm-live-callout-icon": {
    color: "var(--md-callout)",
    display: "inline-block",
    verticalAlign: "-0.2em",
    marginRight: "0.4em",
  },
  ".cm-live-callout-icon svg": {
    display: "block",
    width: "1.1em",
    height: "1.1em",
  },
  // Its text the text's colour, its title its own, not a quote's grey.
  ".cm-live-callout .cm-md-quote": { color: "inherit" },
  // The rule's characters are hidden: the line draws it.
  ".cm-live-hr": {
    background:
      "linear-gradient(var(--rule), var(--rule)) center / 100% 1px no-repeat",
  },
  // Its background from its containers' indent (11e.1b): a quote's room,
  // an item's (below, once the item's rules are known).
  ".cm-line.cm-live-codeblock": {
    "--code-indent": "var(--quote-pad, 0em)",
    fontFamily: "var(--font-code)",
    fontSize: "0.9em",
    background:
      "linear-gradient(to right, transparent var(--code-indent), var(--code-bg) var(--code-indent)), var(--md-callout-tint, transparent)",
    paddingLeft: "calc(var(--code-indent) + 0.6em)",
  },
  // The block has the background; its code spans need none of their own.
  ".cm-live-codeblock .cm-md-code": { background: "none" },
  ".cm-live-fence": { color: "var(--muted)" },
  // A list item hangs under its text: its marker is a fixed
  // width, its lines start that much further in, by depth — after a
  // quote's own room when in one. After the quote's rule, to win.
  ".cm-line.cm-live-li": {
    paddingLeft: "calc(var(--quote-pad, 0em) + (var(--li-depth) + 1) * 1.6em)",
    textIndent: "-1.6em",
  },
  ".cm-line.cm-live-li-cont": {
    paddingLeft: "calc(var(--quote-pad, 0em) + (var(--li-depth) + 1) * 1.6em)",
  },
  // A touched item's line, its source: its indentation as wide as the
  // depth's (ADR-0054), its marker where the bullet stands.
  ".cm-live-li-indent, .cm-live-li-indent-cont": {
    display: "inline-block",
    overflow: "hidden",
    whiteSpace: "pre",
    verticalAlign: "top",
    width: "calc(var(--li-depth) * 1.6em)",
  },
  ".cm-live-li-indent-cont": {
    width: "calc((var(--li-depth) + 1) * 1.6em)",
  },
  ".cm-live-bullet, .cm-live-num, .cm-live-task-marker": {
    display: "inline-block",
    minWidth: "1.6em",
    textIndent: "0",
  },
  ".cm-live-bullet": { color: "var(--muted)" },
  ".cm-live-image": { maxWidth: "100%", verticalAlign: "middle" },
  ".cm-live-remote-image": { verticalAlign: "middle" },
  // Its own box holds KaTeX's margins (`.katex-display`, 1em): through
  // it, CodeMirror would not count them, and a click below the formula
  // would land a line too high.
  ".cm-live-math-display": { display: "flow-root", textAlign: "center" },
  ".cm-live-table": { overflowX: "auto", padding: "0.3em 0" },
  // A table or formula block in a quote or a list item (11e.1b), as
  // their lines.
  ".cm-live-block-quoted.cm-live-block-quoted": {
    // Its rule along a formula's margins too (they would collapse out).
    display: "flow-root",
    "--quote-pad": "0.8em",
    borderLeft: "3px solid var(--rule)",
    paddingLeft: "0.8em",
  },
  // In a callout: its colour, as its lines; a
  // plain quote in it adds its rule (above).
  ".cm-live-block-callout.cm-live-block-callout": {
    display: "flow-root",
    "--quote-pad": "0.8em",
    "--md-callout": "var(--md-callout-color, var(--md-callout-note))",
    background: "color-mix(in srgb, var(--md-callout) 10%, transparent)",
    paddingLeft: "0.8em",
  },
  ".cm-live-block-item.cm-live-block-item": {
    paddingLeft: "calc(var(--quote-pad, 0em) + (var(--li-depth) + 1) * 1.6em)",
  },
  // On its item's first line: the item's marker where its lines have it.
  ".cm-live-block-item": { position: "relative" },
  ".cm-live-block-marker": {
    position: "absolute",
    top: "0.3em",
    left: "calc(var(--quote-pad, 0em) + var(--li-depth) * 1.6em)",
  },
  // A code block's lines in a list item (after the item's rules, to win).
  ".cm-line.cm-live-codeblock.cm-live-li-cont": {
    "--code-indent":
      "calc(var(--quote-pad, 0em) + (var(--li-depth) + 1) * 1.6em)",
    paddingLeft: "calc(var(--code-indent) + 0.6em)",
  },
  ".cm-live-table table": { borderCollapse: "collapse" },
  ".cm-live-table a": { color: "var(--pencil)" },
  ".cm-live-table th, .cm-live-table td": {
    border: "1px solid var(--rule)",
    padding: "0.2rem 0.5rem",
  },
  ".cm-live-task": {
    margin: "0 0.3em 0 0",
    verticalAlign: "middle",
    accentColor: "var(--pencil)",
  },
});
