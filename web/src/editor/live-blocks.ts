import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { count, span } from "../perf/index.js";
import {
  type CalloutFamily,
  leavingHref,
  renderMarkdown,
} from "../render/index.js";
import { calloutOf } from "./callout-node.js";
import {
  type RevealSource,
  liveReveal,
  revealsBetween,
} from "./live-reveal.js";
import { MathWidget, drawFormula } from "./live-widgets.js";

/** The callout a block is in: its innermost one's
 * family, and whether a plain quote holds the block in there (its rule). */
export interface BlockCallout {
  family: CalloutFamily;
  rule: boolean;
}

/** A block replaced by its rendering: its whole lines, `[from, to]`. */
export interface BlockSpec {
  kind: "table" | "math";
  from: number;
  to: number;
  /** A table's Markdown (without its containers' markers), a formula's
   * TeX. */
  source: string;
  /** A formula's number. */
  tag?: string;
  /** A block in quotes: how many. */
  quote?: number;
  /** A block in a list item: the item's depth, from 0. */
  list?: number;
  /** A block on its item's first line: the item's marker, drawn with it. */
  marker?: string;
  /** A block in a callout: its colour, and a plain quote's rule. */
  callout?: BlockCallout;
}

/** The tables and formula blocks to show rendered,
 * from the top-level blocks (analysis 11a.1, point 4, option (a)), and the
 * tables in quotes and list items (11e.1b), one step per block looked at.
 * A nested table is rendered only when each of its lines holds nothing but
 * its containers' markers before it — on its item's first line, the item's
 * marker too, drawn with it (not a task's box, not a lazy line) —, and so
 * is a formula block, its TeX without the quotes' markers. With the
 * focus, a block that a selection range touches is its source (decisions
 * 3, and point 1); so is one that holds an open annotation, active or not
 * (decision 7: its marks need its text), not one with a remote caret
 * (drawn at the widget's edge). A block in a callout takes its innermost
 * one's colour. Pure. */
export function liveBlocks(
  tree: Tree,
  doc: Text,
  selection: readonly { from: number; to: number }[],
  focused: boolean,
  reveal: RevealSource = () => [],
): BlockSpec[] {
  count("live.blocks");
  const specs: BlockSpec[] = [];
  const shown = (from: number, to: number): boolean =>
    !(
      focused && selection.some((range) => range.from <= to && from <= range.to)
    ) && !reveal(from, to).some((range) => range.kind !== "cursor");
  const walk = (
    parent: SyntaxNode,
    quote: number,
    list: number,
    callout?: BlockCallout,
  ): void => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      count("live.block");
      if (node.name === "Blockquote") {
        const family = calloutOf(node, doc)?.header.family;
        walk(
          node,
          quote + 1,
          list,
          family
            ? { family, rule: false }
            : callout && { ...callout, rule: true },
        );
        continue;
      }
      if (node.name === "BulletList" || node.name === "OrderedList") {
        for (let item = node.firstChild; item; item = item.nextSibling)
          if (item.name === "ListItem") walk(item, quote, list + 1, callout);
        continue;
      }
      if (node.name !== "Table" && node.name !== "MathBlock") continue;
      const from = doc.lineAt(node.from).from;
      const to = doc.lineAt(node.to).to;
      if (!shown(from, to)) continue;
      const nested = quote > 0 || list >= 0;
      const marker = nested ? lead(node, doc, quote) : undefined;
      if (marker === null) continue;
      const place = {
        ...(quote > 0 && { quote }),
        ...(list >= 0 && { list }),
        ...(marker !== undefined && { marker }),
        ...(callout && { callout }),
      };
      if (node.name === "Table") {
        const source = nested
          ? nestedTable(node, doc, quote)
          : doc.sliceString(from, to);
        if (source === null) continue;
        specs.push({ kind: "table", from, to, source, ...place });
      } else {
        const formula = formulaOf(node, doc);
        if (!formula) continue;
        if (nested) {
          const tex = nestedTex(formula.source, quote);
          if (tex === null) continue;
          formula.source = tex;
        }
        specs.push({ kind: "math", from, to, ...formula, ...place });
      }
    }
  };
  walk(tree.topNode, 0, -1);
  return specs;
}

/** What stands before a nested block on its first line: nothing but its
 * quotes' markers (undefined), or its item's marker after them, the block
 * being the item's first (that marker: a bullet's dot, a number as
 * written); null for anything else, or not as many quote markers. */
function lead(
  node: SyntaxNode,
  doc: Text,
  quote: number,
): string | undefined | null {
  const line = doc.lineAt(node.from);
  const before = doc.sliceString(line.from, node.from);
  if ((before.match(/>/g) ?? []).length !== quote) return null;
  if (/^[ \t>]*$/.test(before)) return undefined;
  // Only its item's marker can stand there: the block is its first.
  const mark = node.parent?.name === "ListItem" ? node.parent.firstChild : null;
  if (mark?.name !== "ListMark") return null;
  const text = doc.sliceString(mark.from, mark.to);
  return /^[-*+]$/.test(text) ? "•" : text;
}

/** A nested table's Markdown, its rows without their containers'
 * markers; null when a later row's line holds anything else before it, or
 * not as many quote markers (a lazy line). */
function nestedTable(
  node: SyntaxNode,
  doc: Text,
  quote: number,
): string | null {
  const rows: string[] = [];
  const first = doc.lineAt(node.from).number;
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (
      row.name !== "TableHeader" &&
      row.name !== "TableRow" &&
      row.name !== "TableDelimiter"
    )
      continue;
    const line = doc.lineAt(row.from);
    const before = doc.sliceString(line.from, row.from);
    if (line.number !== first) {
      if (!/^[ \t>]*$/.test(before)) return null;
      if ((before.match(/>/g) ?? []).length !== quote) return null;
    }
    rows.push(doc.sliceString(row.from, row.to));
  }
  return rows.join("\n");
}

/** A nested formula's TeX, each line after the first without its quotes'
 * markers; null when a line has not as many (a lazy line). */
function nestedTex(tex: string, quote: number): string | null {
  if (quote === 0) return tex;
  const markers = new RegExp(`^(?:[ \\t]*>[ \\t]?){${quote}}`);
  const lines = tex.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!markers.test(line)) return null;
    lines[i] = line.replace(markers, "");
  }
  return lines.join("\n");
}

function formulaOf(
  node: SyntaxNode,
  doc: Text,
): { source: string; tag?: string } | null {
  const marks = node.getChildren("MathMark");
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return null;
  const tag = node.getChild("MathTag");
  return {
    source: doc.sliceString(open.to, close.from),
    ...(tag && { tag: doc.sliceString(tag.from + 1, tag.to - 1) }),
  };
}

/** Where a nested block is: its containers, as its spec says them. */
interface Place {
  quote: number;
  list?: number | undefined;
  marker?: string | undefined;
  callout?: BlockCallout | undefined;
}

const samePlace = (a: Place, b: Place): boolean =>
  a.quote === b.quote &&
  a.list === b.list &&
  a.marker === b.marker &&
  a.callout?.family === b.callout?.family &&
  a.callout?.rule === b.callout?.rule;

/** A nested block in its containers' place: a quote's rule, an item's
 * indent, a callout's colour, as their lines have them (11e.1b). */
function place(
  element: HTMLElement,
  { quote, list, marker, callout }: Place,
): void {
  if (callout) {
    element.classList.add("cm-live-block-callout");
    element.style.setProperty(
      "--md-callout-color",
      `var(--md-callout-${callout.family})`,
    );
  }
  if (callout ? callout.rule : quote > 0)
    element.classList.add("cm-live-block-quoted");
  if (list !== undefined) {
    element.classList.add("cm-live-block-item");
    element.style.setProperty("--li-depth", String(list));
  }
  if (marker !== undefined) {
    // On its item's first line: the item's marker, where its lines have it.
    const drawn = document.createElement("span");
    drawn.className = `cm-live-block-marker ${marker === "•" ? "cm-live-bullet" : "cm-live-num"}`;
    drawn.textContent = marker;
    element.prepend(drawn);
  }
}

/** A formula block, in its containers' place when nested. */
function mathWidget(tex: string, at: Place): MathWidget {
  return at.quote > 0 || at.list !== undefined
    ? new NestedMathWidget(tex, at)
    : new MathWidget(tex, true, true);
}

/** A formula block in a quote or a list item. */
class NestedMathWidget extends MathWidget {
  constructor(
    tex: string,
    readonly at: Place,
  ) {
    super(tex, true, true);
  }
  override eq(other: MathWidget): boolean {
    return (
      other instanceof NestedMathWidget &&
      super.eq(other) &&
      samePlace(other.at, this.at)
    );
  }
  override toDOM(view: EditorView): HTMLElement {
    // A wrapper: the formula is drawn again once KaTeX is loaded.
    const element = document.createElement("div");
    element.append(super.toDOM(view));
    place(element, this.at);
    return element;
  }
}

/** A table, rendered as the preview renders it, in its containers' place (`render/`, markdown-it
 * without HTML, ADR-0021), its formulas drawn. A plain click on a link in
 * it places the caret (decision 9), which shows the source; Ctrl/Cmd+click
 * follows one that leaves the document, as its own target says (a new tab,
 * no opener), never one inside it. */
class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly at: Place,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source && samePlace(other.at, this.at);
  }
  override get estimatedHeight(): number {
    return this.source.split("\n").length * 34;
  }
  override toDOM(view: EditorView): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-live-table";
    element.innerHTML = renderMarkdown(this.source);
    place(element, this.at);
    for (const formula of Array.from(
      element.querySelectorAll<HTMLElement>(".math"),
    )) {
      drawFormula(
        view,
        formula,
        formula.dataset.tex ?? "",
        formula.classList.contains("math-display"),
      );
    }
    // Ctrl/Cmd+click on a link that leaves the document: followed by the
    // link itself, the editor keeps its caret. Any other click on a link is
    // not followed — never one inside the document (decision 9).
    const leaving = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link) return null;
      return (
        (event.ctrlKey || event.metaKey) &&
        leavingHref(link.getAttribute("href") ?? "") !== null
      );
    };
    element.addEventListener("mousedown", (event) => {
      if (leaving(event)) event.stopPropagation();
    });
    element.addEventListener("click", (event) => {
      if (leaving(event) === false) event.preventDefault();
    });
    return element;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const focusChanged = StateEffect.define<boolean>();

/** Whether the editor has the focus, for a state field (which sees no
 * view). */
const focusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects)
      if (effect.is(focusChanged)) return effect.value;
    return focused;
  },
});

function build(state: EditorState): DecorationSet {
  // Measured with `?perf`: `oc:live.blocks`.
  const specs = span("live.blocks", () =>
    liveBlocks(
      syntaxTree(state),
      state.doc,
      state.selection.ranges,
      state.field(focusField),
      (from, to) => revealsBetween(state.facet(liveReveal), from, to),
    ),
  );
  return Decoration.set(
    specs.map((spec) => {
      const at: Place = {
        quote: spec.quote ?? 0,
        list: spec.list,
        marker: spec.marker,
        callout: spec.callout,
      };
      return Decoration.replace({
        widget:
          spec.kind === "table"
            ? new TableWidget(spec.source, at)
            : mathWidget(
                spec.tag === undefined
                  ? spec.source
                  : `${spec.source}\\tag{${spec.tag}}`,
                at,
              ),
        block: true,
      }).range(spec.from, spec.to);
    }),
  );
}

/** The block widgets (option (a)): recomputed when the text, the
 * selection, the focus, what other layers keep in sight or the syntax
 * tree change; a block-replacing
 * decoration must come from a state field, not a plugin. */
const blocksField = StateField.define<DecorationSet>({
  create: build,
  update(blocks, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((effect) => effect.is(focusChanged)) ||
      tr.startState.facet(liveReveal) !== tr.state.facet(liveReveal) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    )
      return build(tr.state);
    return blocks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const liveBlocksExtension: Extension = [
  focusField,
  EditorView.focusChangeEffect.of((_state, focusing) =>
    focusChanged.of(focusing),
  ),
  blocksField,
];
