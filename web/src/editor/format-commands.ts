import { ensureSyntaxTree } from "@codemirror/language";
import {
  type ChangeSet,
  type ChangeSpec,
  type EditorState,
  MapMode,
  type TransactionSpec,
} from "@codemirror/state";
import type { Command } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { count } from "../perf/index.js";
import {
  type BlockConstruct,
  CONSTRUCTS,
  type ConstructId,
  type InlineConstruct,
  type LineConstruct,
  calloutConstruct,
  construct,
} from "./constructs.js";
// The formatting commands (ADR-0046 §2): a
// construction of the catalogue applied to the text, as one transaction of
// the user's, which the editor's link sends to Loro like a keystroke.
// Pure: an editor state in, a transaction's spec out, null when nothing
// is to be done.
import { mayInsertImage, pickImage } from "./image-insertion.js";
import { markdownParser } from "./markdown-syntax.js";

/** How long a command waits for the editor's parse before parsing the
 * text itself: a command is a gesture, not a keystroke. */
const PARSE_BUDGET_MS = 100;

/** The construction as an editor's command, for a key, a button, the /
 * menu: done in one transaction. It keeps the key from the browser even
 * when there is nothing to do (Ctrl+B would open Firefox's bookmarks);
 * not where the editor may not type. */
export function runConstruct(id: ConstructId): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const spec = constructTransaction(view.state, id);
    if (spec) view.dispatch({ ...spec, scrollIntoView: true });
    return true;
  };
}

export function constructTransaction(
  state: EditorState,
  id: ConstructId,
): TransactionSpec | null {
  const it = construct(id);
  if (it.kind === "inline") return toggleInline(state, it);
  if (it.kind === "line") return toggleLines(state, it);
  if (it.kind === "block") return insertBlock(state, it);
  if (it.id === "image") {
    return mayInsertImage(state) ? { effects: pickImage.of(null) } : null;
  }
  return it.id === "link" ? link(state) : footnote(state);
}

/** A callout of `family`, titled `title` (ADR-0063, EN3), as a block. */
export function calloutTransaction(
  state: EditorState,
  family: string,
  title: string,
): TransactionSpec | null {
  return insertBlock(state, calloutConstruct(family, title));
}

/** Whether the selection (the caret) is in the construction: what the
 * toolbar shows, what a toggle undoes. */
export function constructActive(
  state: EditorState,
  id: ConstructId,
  tree: Tree = treeOf(state),
): boolean {
  const it = construct(id);
  if (it.kind === "line") return linesActive(state, it, tree);
  if (it.kind !== "inline") return false;
  const parts = segments(state);
  return (
    parts.length > 0 && parts.every((part) => inlineAt(state, it, part, tree))
  );
}

/** How long the toolbar's state waits for the editor's parse: it is
 * computed as the caret moves, and says nothing rather than wait. */
const STATE_PARSE_BUDGET_MS = 10;

/** How many lines of the selection the toolbar's state looks at, at most. */
const STATE_MAX_LINES = 200;

/** The constructions on at the selection, for the toolbar: read in the
 * text parsed up to the selection's line only, none if the parse isn't
 * there in time, or the selection spans too many lines. */
export function activeConstructs(state: EditorState): ReadonlySet<ConstructId> {
  const { from, to } = state.selection.main;
  // Over more lines, it says nothing rather than look at each: the
  // toolbar reads it as the selection moves (a command looks at them all).
  if (
    state.doc.lineAt(to).number - state.doc.lineAt(from).number >=
    STATE_MAX_LINES
  ) {
    return new Set();
  }
  const upto = state.doc.lineAt(to).to;
  const tree = ensureSyntaxTree(state, upto, STATE_PARSE_BUDGET_MS);
  const on = new Set<ConstructId>();
  if (!tree) return on;
  for (const each of CONSTRUCTS) {
    if (constructActive(state, each.id, tree)) on.add(each.id);
  }
  return on;
}

/** The form the paragraph menu names: a heading's level before a quote,
 * a quote before text; "mixed" when the lines touched differ; null when
 * none has a form (a code block's, the YAML header's). */
export function paragraphForm(
  state: EditorState,
  on: ReadonlySet<ConstructId> = activeConstructs(state),
): LineConstruct["id"] | "mixed" | null {
  const forms: LineConstruct["id"][] = [
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "quote",
    "paragraph",
  ];
  const form = forms.find((each) => on.has(each));
  if (form) return form;
  const { from, to } = state.selection.main;
  // Too many lines to look at: still offered for them all.
  if (
    state.doc.lineAt(to).number - state.doc.lineAt(from).number >=
    STATE_MAX_LINES
  ) {
    return "mixed";
  }
  const upto = state.doc.lineAt(to).to;
  const tree = ensureSyntaxTree(state, upto, STATE_PARSE_BUDGET_MS);
  const paragraph = construct("paragraph") as LineConstruct;
  return tree && selectedLines(state, paragraph, tree).length > 0
    ? "mixed"
    : null;
}

interface Range {
  from: number;
  to: number;
}

/** A line's block markup, before its inline text: quotes, a list item's
 * marker and box, a heading's hashes. */
const LINE_PREFIX =
  /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?/;

/** What an inline construction applies to: on each line the selection
 * touches, its part after the line's block markup, the edges' spaces left
 * out (`** b **` would not be bold); a blank part is none. The caret
 * alone, without a selection. */
function segments(state: EditorState): Range[] {
  const selection = state.selection.main;
  if (selection.empty) return [{ from: selection.from, to: selection.from }];
  const parts: Range[] = [];
  for (let at = selection.from; at <= selection.to; ) {
    const line = state.doc.lineAt(at);
    count("format.line");
    const prefix = LINE_PREFIX.exec(line.text)?.[0].length ?? 0;
    const from = Math.max(selection.from, line.from + prefix);
    const to = Math.min(selection.to, line.to);
    const text = state.doc.sliceString(from, to);
    if (text.trim() !== "") {
      parts.push({
        from: from + (text.length - text.trimStart().length),
        to: to - (text.length - text.trimEnd().length),
      });
    }
    at = line.to + 1;
  }
  return parts;
}

/** Where the construction is around `part`: a node's marks, or the empty
 * marks a toggle without selection left around the caret, which no node
 * reads. */
function inlineAt(
  state: EditorState,
  it: InlineConstruct,
  part: Range,
  tree: Tree = treeOf(state),
): { open: Range; close: Range } | null {
  const { from, to } = part;
  const around = enclosing(tree, it.node, from, to);
  if (around) return marksOf(around);
  const mark = it.mark;
  if (
    from === to &&
    state.doc.sliceString(from - mark.length, from) === mark &&
    state.doc.sliceString(from, from + mark.length) === mark
  ) {
    return {
      open: { from: from - mark.length, to: from },
      close: { from, to: from + mark.length },
    };
  }
  return null;
}

function treeOf(state: EditorState): Tree {
  return (
    ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ??
    markdownParser().parse(state.doc.toString())
  );
}

/** The nearest node named `name` around `from`…`to`: a caret between
 * its marks, a range within it, marks included (selected whole in the
 * source), but not of its marks only. */
function enclosing(
  tree: Tree,
  name: string,
  from: number,
  to: number,
): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = tree.resolveInner(from, 1);
    node;
    node = node.parent
  ) {
    if (node.name !== name) continue;
    const { open, close } = marksOf(node);
    const within =
      from === to
        ? open.to <= from && to <= close.from
        : node.from <= from &&
          to <= node.to &&
          from < close.from &&
          open.to < to;
    if (within) return node;
  }
  return null;
}

/** The marks of an inline node: from its start to its content, from its
 * content to its end (a highlight's color goes with its opening). */
function marksOf(node: SyntaxNode): { open: Range; close: Range } {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name.endsWith("Mark") || child.name === "HighlightColor") {
      marks.push(child);
    }
  }
  const first = marks[0];
  const last = marks.at(-1);
  let openTo = first?.to ?? node.from;
  for (const mark of marks) {
    if (mark.from === openTo) openTo = mark.to;
  }
  return {
    open: { from: node.from, to: openTo },
    close: { from: last && last !== first ? last.from : node.to, to: node.to },
  };
}

function toggleInline(
  state: EditorState,
  it: InlineConstruct,
): TransactionSpec | null {
  const parts = segments(state);
  if (parts.length === 0) return null;
  const found = parts.map((part) => inlineAt(state, it, part));
  if (found.every((marks) => marks)) {
    // Unwrapped: each node's marks once, however many parts are in it.
    const marks = new Map<number, Range[]>();
    for (const each of found) {
      if (each) marks.set(each.open.from, [each.open, each.close]);
    }
    const spec = withSelection(state, [...marks.values()].flat());
    const removed = [...marks.values()].map(([open]) => open as Range);
    return !constructActive(state.update(spec).state, it.id) &&
      keepsOthers(state, spec, it, { removed, added: [] })
      ? spec
      : null;
  }
  // Wrapped, each part as selected, else to its words' edges (`a**.b**c`
  // is not bold, `**a.bc**` is); never marks that don't read as the
  // construction (WA3).
  const changes: ChangeSpec[] = [];
  const added: Range[] = [];
  for (const [index, part] of parts.entries()) {
    if (found[index]) continue;
    const wrapped = [part, wordsAround(state, part)]
      .map((range) => [
        { from: range.from, insert: it.mark },
        { from: range.to, insert: it.mark },
      ])
      .find((wrap) =>
        inlineAt(state.update({ changes: wrap }).state, it, {
          from: part.from + it.mark.length,
          to: part.to + it.mark.length,
        }),
      );
    if (!wrapped) return null;
    changes.push(...wrapped);
    const [open, close] = wrapped;
    if (part.from < part.to && open && close) {
      added.push({ from: open.from, to: close.from });
    }
  }
  const spec = state.selection.main.empty
    ? {
        changes: state.changes(changes),
        selection: { anchor: state.selection.main.from + it.mark.length },
        userEvent: "input.format",
      }
    : withSelection(state, changes);
  return constructActive(state.update(spec).state, it.id) &&
    keepsOthers(state, spec, it, { removed: [], added })
    ? spec
    : null;
}

/** Whether, after `spec`, the construction is where it was but in the
 * nodes `removed`, moved by the changes, and around the ranges `added`
 * (before the changes), with their marks: marks put next to others may
 * pair with them (`=~~‸~~=~~` strikes the `=`), or others pair anew
 * around them (`=__=**==__**__`); marks taken off may leave others to
 * pair anew. */
function keepsOthers(
  state: EditorState,
  spec: TransactionSpec & { changes: ChangeSet },
  it: InlineConstruct,
  change: { removed: readonly Range[]; added: readonly Range[] },
): boolean {
  const after = state.update(spec).state;
  const now = new Set(
    nodesNamed(after, it.node).map((node) => `${node.from}:${node.to}`),
  );
  const { changes } = spec;
  const expected = [
    ...nodesNamed(state, it.node)
      .filter((node) => !change.removed.some((gone) => gone.from === node.from))
      .map(
        (node) =>
          `${changes.mapPos(node.from, 1)}:${changes.mapPos(node.to, -1)}`,
      ),
    ...change.added.map(
      (range) =>
        `${changes.mapPos(range.from, -1)}:${changes.mapPos(range.to, 1)}`,
    ),
  ];
  return (
    now.size === expected.length && expected.every((node) => now.has(node))
  );
}

function nodesNamed(state: EditorState, name: string): Range[] {
  const nodes: Range[] = [];
  treeOf(state).iterate({
    enter(node) {
      if (node.name === name) nodes.push({ from: node.from, to: node.to });
    },
  });
  return nodes;
}

/** The changes, the selection kept on the text they wrap or unwrap. */
function withSelection(
  state: EditorState,
  spec: ChangeSpec,
): TransactionSpec & { changes: ChangeSet } {
  const changes = state.changes(spec);
  const { anchor, head, empty } = state.selection.main;
  const forward = anchor <= head;
  // A caret stays one, after what is put at it (a heading's hashes at
  // the line's start): the next keystroke must not replace them.
  return {
    changes,
    selection: {
      anchor: changes.mapPos(anchor, forward ? 1 : -1),
      head: changes.mapPos(head, empty || !forward ? 1 : -1),
    },
    userEvent: "input.format",
  };
}

const WORD = /[\p{L}\p{N}]/u;

/** `part` widened to the letters and digits it touches, on its line. */
function wordsAround(state: EditorState, part: Range): Range {
  const line = state.doc.lineAt(part.from);
  let from = part.from;
  while (from > line.from && WORD.test(state.doc.sliceString(from - 1, from)))
    from--;
  let to = part.to;
  while (to < line.to && WORD.test(state.doc.sliceString(to, to + 1))) to++;
  return { from, to };
}

/** A line's block markup, read in parts: its quotes, indent, list marker,
 * task box and heading hashes, then its text. */
const LINE =
  /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*)((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))?(\[[ xX]\](?:[ \t]+|$))?(#{1,6}(?:[ \t]+|$))?/;

interface LineParts {
  quotes: string;
  indent: string;
  marker: string;
  box: string;
  heading: string;
  /** Where the line's text starts, from the line's start. */
  text: number;
}

/** The parts of the line at `from`; a list marker only where the parser
 * reads one (`2) a` under a paragraph continues it). */
function partsOf(tree: Tree, from: number, line: string): LineParts {
  const [
    all = "",
    quotes = "",
    indent = "",
    found = "",
    box = "",
    heading = "",
  ] = LINE.exec(line) ?? [];
  const listed =
    found !== "" &&
    tree.resolveInner(from + quotes.length + indent.length, 1).name ===
      "ListMark";
  // Without a list marker, what looks like one or like a task's box is
  // text, and so is what follows it.
  if (!listed && (found !== "" || box !== "")) {
    return {
      quotes,
      indent,
      marker: "",
      box: "",
      heading: "",
      text: quotes.length + indent.length,
    };
  }
  return { quotes, indent, marker: found, box, heading, text: all.length };
}

type Form = (parts: LineParts) => boolean;

const LEVEL = (parts: LineParts) => parts.heading.trimEnd().length;

function formOf(id: LineConstruct["id"]): Form {
  switch (id) {
    case "paragraph":
      return (parts) => LEVEL(parts) === 0;
    case "bulletList":
      return (parts) => /^[-*+]/.test(parts.marker) && parts.box === "";
    case "orderedList":
      return (parts) => /^\d/.test(parts.marker);
    case "taskList":
      return (parts) => parts.box !== "";
    case "quote":
      return (parts) => parts.quotes !== "";
    default:
      return (parts) => LEVEL(parts) === Number(id.slice("heading".length));
  }
}

/** The lines a line construction applies to: those the selection
 * touches (not the one it ends at the start of), but those of a code
 * block, a formula or the YAML header; blank ones only for a quote, or
 * the caret's alone (a heading, a list started before its text). */
function selectedLines(
  state: EditorState,
  it: LineConstruct,
  tree: Tree = treeOf(state),
): { from: number; text: string }[] {
  const { from, to, empty } = state.selection.main;
  const lines: { from: number; text: string }[] = [];
  const caret = state.doc.lineAt(from);
  const alone = empty && caret.text.trim() === "";
  for (let at = from; at <= to; ) {
    const line = state.doc.lineAt(at);
    count("format.line");
    at = line.to + 1;
    if (!empty && line.from === to && line.from > from) break;
    if (it.id !== "quote" && !alone && line.text.trim() === "") continue;
    if (it.id !== "quote" && inVerbatim(tree, line.from, line.to)) continue;
    lines.push({ from: line.from, text: line.text });
  }
  return lines;
}

const VERBATIM = new Set([
  "FencedCode",
  "CodeBlock",
  "MathBlock",
  "FrontMatter",
  "HTMLBlock",
]);

function inVerbatim(tree: Tree, from: number, to: number): boolean {
  for (
    let node: SyntaxNode | null = tree.resolveInner(Math.min(from + 1, to), -1);
    node;
    node = node.parent
  ) {
    if (VERBATIM.has(node.name)) return true;
  }
  return false;
}

function linesActive(
  state: EditorState,
  it: LineConstruct,
  tree: Tree = treeOf(state),
): boolean {
  const lines = selectedLines(state, it, tree);
  const form = formOf(it.id);
  return (
    lines.length > 0 &&
    lines.every((line) => form(partsOf(tree, line.from, line.text)))
  );
}

/** A heading's hashes, a list's marker, a quote's `> ` put on each line
 * the selection touches, or taken off when every line has them; another
 * level or another list replaced (ADR-0046 §2). */
function toggleLines(
  state: EditorState,
  it: LineConstruct,
): TransactionSpec | null {
  const lines = selectedLines(state, it);
  if (lines.length === 0) return null;
  const off = linesActive(state, it);
  if (off && it.id === "paragraph") return null;
  const tree = treeOf(state);
  const changes: { from: number; to: number; insert: string }[] = [];
  let number = 0;
  for (const line of lines) {
    const parts = partsOf(tree, line.from, line.text);
    const prefix = rewritten(line.text, parts, it.id, off, ++number);
    if (prefix === null) continue;
    const old = line.text.slice(0, parts.text);
    if (prefix !== old) {
      changes.push({
        from: line.from,
        to: line.from + parts.text,
        insert: prefix,
      });
    }
  }
  const [only] = lines;
  const [change] = changes;
  if (!off && lines.length === 1 && only?.text.trim() === "" && change) {
    return onBlank(state, it, change);
  }
  if (changes.length === 0) return null;
  const spec = separated(state, it, lines, off, tree, [...changes]);
  return formed(state, it, lines, off, spec) ? spec : null;
}

/** The markup on the caret's blank line, the caret after it (a heading,
 * a list started before its text), with a line between, above or below,
 * where needed: the line reads as asked, empty and once typed in, and the
 * lines around as they did. Under a paragraph, `a\n1. ` continues it and
 * `a\n- ` underlines it; above one, `- x\nb` takes it in. */
function onBlank(
  state: EditorState,
  it: LineConstruct,
  change: { from: number; to: number; insert: string },
): TransactionSpec | null {
  const line = state.doc.lineAt(change.from);
  const shapes = (at: EditorState, numbers: number[]) =>
    JSON.stringify(
      numbers.map((number) => {
        if (number < 1 || number > at.doc.lines) return null;
        const around = at.doc.line(number);
        return around.text.trim() === "" ? null : shapeOf(at, around.from);
      }),
    );
  const was = shapes(state, [line.number - 1, line.number + 1]);
  for (const [above, below] of [
    ["", ""],
    ["\n", ""],
    ["", "\n"],
    ["\n", "\n"],
  ] as const) {
    const caret = change.from + above.length + change.insert.length;
    const spec = {
      changes: {
        from: change.from,
        to: change.to,
        insert: `${above}${change.insert}${below}`,
      },
      selection: { anchor: caret },
      userEvent: "input.format",
    };
    const after = state.update(spec).state;
    const number = line.number + above.length;
    const reads = ["", "x"].every((typed) => {
      const now = after.update({
        changes: { from: caret, insert: typed },
      }).state;
      const shape = shapeOf(now, now.doc.line(number).from);
      return (
        shape !== null &&
        (it.id === "quote" ? shape.quotes > 0 : hasShape(shape, it.id)) &&
        shapes(now, [line.number - 1, number + 1 + below.length]) === was
      );
    });
    if (reads) return spec;
  }
  return null;
}

/** Whether each line reads as asked after `spec`: never `2) a` under a
 * paragraph (text), `- 2) a` (a list in a list). */
function formed(
  state: EditorState,
  it: LineConstruct,
  lines: readonly { from: number; text: string }[],
  off: boolean,
  spec: TransactionSpec,
): boolean {
  const after = state.update(spec);
  return lines.every((line) => {
    const was = shapeOf(state, line.from);
    const now = shapeOf(after.state, after.changes.mapPos(line.from, 1));
    if (!was || !now) return was === now;
    if (it.id === "quote") {
      return off ? now.quotes === was.quotes - 1 : now.quotes > 0;
    }
    return hasShape(now, it.id) !== off;
  });
}

function separated(
  state: EditorState,
  it: LineConstruct,
  lines: readonly { from: number; text: string }[],
  off: boolean,
  tree: Tree,
  changes: ChangeSpec[],
): TransactionSpec & { changes: ChangeSet } {
  const first = lines[0];
  if (off && first && continues(state, it, first.from)) {
    // Out of a list or a quote, under a line still in it, a line would
    // stay in it, as a lazy continuation (`- a\nb`): a line between.
    const prefix =
      rewritten(
        first.text,
        partsOf(tree, first.from, first.text),
        it.id,
        off,
        1,
      ) ?? "";
    changes.push({
      from: first.from,
      insert: `${prefix.replace(/[^>]/g, "").replace(/>/g, "> ").trimEnd()}\n`,
    });
  }
  return withSelection(state, changes);
}

/** Whether the line before `from`, not taken off, is in the list or the
 * quote the line at `from` leaves. */
function continues(
  state: EditorState,
  it: LineConstruct,
  from: number,
): boolean {
  if (from === 0) return false;
  const above = state.doc.lineAt(from - 1);
  if (above.text.trim() === "") return false;
  const name = it.id === "quote" ? "Blockquote" : "ListItem";
  for (
    let node: SyntaxNode | null = treeOf(state).resolveInner(above.to, -1);
    node;
    node = node.parent
  ) {
    if (node.name === name) return true;
  }
  return false;
}

/** The new block markup of a line, before its text. */
function rewritten(
  line: string,
  parts: LineParts,
  id: LineConstruct["id"],
  off: boolean,
  number: number,
): string | null {
  const { quotes, indent, marker, box, heading } = parts;
  switch (id) {
    case "paragraph":
      return quotes + indent + marker + box;
    // Out of a list, its indent goes too: it nested the item (`  w1`
    // under `- w0` would be the item's paragraph).
    case "bulletList":
      return off ? quotes + heading : `${quotes}${indent}- ${heading}`;
    case "orderedList":
      return off ? quotes + heading : `${quotes}${indent}${number}. ${heading}`;
    case "taskList":
      return off
        ? quotes + heading
        : `${quotes}${indent}- ${box || "[ ] "}${heading}`;
    case "quote": {
      if (!off) {
        if (parts.quotes !== "") return null;
        // A blank line quoted keeps no trailing space.
        return line.trim() === ""
          ? ">"
          : `> ${indent}${marker}${box}${heading}`;
      }
      const one = /^[ \t]{0,3}>[ \t]?/.exec(quotes)?.[0] ?? "";
      return quotes.slice(one.length) + indent + marker + box + heading;
    }
    default: {
      // A task can't be a heading: `- [ ] # a` is a paragraph.
      const level = Number(id.slice("heading".length));
      if (off) return quotes + indent + marker + box;
      return `${quotes}${indent}${marker}${"#".repeat(level)} `;
    }
  }
}

/** A block's template after the top-level block the caret is in (a
 * paragraph, a list, a code block are never cut), or on the blank line
 * it is on; a blank line between it and the text around. */
function insertBlock(
  state: EditorState,
  it: BlockConstruct,
): TransactionSpec | null {
  const { doc } = state;
  const caret = doc.lineAt(state.selection.main.head);
  // The top-level block around the caret's line: on its blank line too (a
  // code block's, a list's).
  let top: SyntaxNode | null = treeOf(state).resolveInner(caret.from, 1);
  while (top?.parent && top.parent.name !== "Document") top = top.parent;
  const inside =
    top !== null &&
    top.name !== "Document" &&
    top.from <= caret.from &&
    caret.to <= top.to &&
    (caret.text.trim() !== "" || (top.from < caret.from && caret.to < top.to));
  const at = inside && top ? doc.lineAt(top.to).to : caret.from;
  const line = doc.lineAt(at);
  const blank = !inside && line.text.trim() === "";
  const before = !blank
    ? "\n\n"
    : at > 0 && doc.lineAt(at - 1).text.trim() !== ""
      ? "\n"
      : "";
  const after =
    line.number < doc.lines && doc.line(line.number + 1).text.trim() !== ""
      ? "\n"
      : "";
  const insert = `${before}${it.template}${after}`;
  const spec = {
    changes: { from: at, to: blank ? line.to : at, insert },
    selection: {
      anchor: at + before.length + it.selected.from,
      head: at + before.length + it.selected.to,
    },
    userEvent: "input.format",
  };
  // Never in what the text leaves open to its end (a code block's fence
  // not closed): the template has to start its own block.
  const start = at + before.length;
  const tree = treeOf(state.update(spec).state);
  let node: SyntaxNode | null = tree.resolveInner(start, 1);
  while (node && node.from === start && node.name !== it.node)
    node = node.parent;
  return node?.name === it.node && node.from === start ? spec : null;
}

const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** Ctrl/Cmd+K: in a link, its address selected; else the selection as a
 * link's text, the caret where its address goes, or a selected address
 * in the parentheses, the caret where the text goes. */
function link(state: EditorState): TransactionSpec | null {
  const { from, to } = state.selection.main;
  const tree = treeOf(state);
  for (
    let node: SyntaxNode | null = tree.resolveInner(from, 1);
    node;
    node = node.parent
  ) {
    if (node.name !== "Link" || to > node.to) continue;
    const url = node.getChild("URL");
    const open = node
      .getChildren("LinkMark")
      .find((mark) => state.sliceDoc(mark.from, mark.to) === "(");
    if (url) return { selection: { anchor: url.from, head: url.to } };
    if (open) return { selection: { anchor: open.to } };
    return null;
  }
  if (inCode(tree, from)) return null;
  // Put around the selection, never in its place: what is selected keeps
  // its annotations' anchors.
  const selected = state.sliceDoc(from, to);
  const spec: TransactionSpec = ADDRESS.test(selected)
    ? {
        changes: [
          { from, insert: "[](" },
          { from: to, insert: ")" },
        ],
        selection: { anchor: from + 1 },
      }
    : {
        changes: [
          { from, insert: "[" },
          { from: to, insert: "]()" },
        ],
        selection: { anchor: from + selected.length + (from === to ? 1 : 3) },
      };
  const after = treeOf(state.update(spec).state);
  let node: SyntaxNode | null = after.resolveInner(from, 1);
  while (node && node.name !== "Link") node = node.parent;
  return node?.from === from ? { ...spec, userEvent: "input.format" } : null;
}

const CODE = new Set([...VERBATIM, "InlineCode", "InlineMath", "DisplayMath"]);

/** Whether `pos` is in code, a formula or the YAML header: where a
 * construction's markup would be text. */
export function inCodeAt(state: EditorState, pos: number): boolean {
  return inCode(treeOf(state), pos);
}

function inCode(tree: Tree, pos: number): boolean {
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (CODE.has(node.name)) return true;
  }
  return false;
}

/** A footnote's reference at the end of the selection, numbered after
 * the text's others, its definition at the text's end, the caret there. */
function footnote(state: EditorState): TransactionSpec | null {
  const at = state.selection.main.to;
  if (inCode(treeOf(state), at)) return null;
  const text = state.doc.toString();
  const numbers = [...text.matchAll(/\[\^(\d+)\]/g)].map((match) =>
    Number(match[1]),
  );
  const label = `[^${Math.max(0, ...numbers) + 1}]`;
  const gap =
    text.endsWith("\n\n") || text === ""
      ? ""
      : text.endsWith("\n")
        ? "\n"
        : "\n\n";
  const definition = `${gap}${label}: `;
  return {
    changes: [
      { from: at, insert: label },
      { from: text.length, insert: definition },
    ],
    selection: { anchor: text.length + label.length + definition.length },
    userEvent: "input.format",
  };
}

interface Shape {
  heading: number;
  list: "bullet" | "ordered" | "task" | null;
  quotes: number;
}

/** How the editor's parser reads the line starting at `from`: null in a
 * code block, a formula, the YAML header. */
function shapeOf(state: EditorState, from: number): Shape | null {
  const line = state.doc.lineAt(from);
  const tree = treeOf(state);
  if (inVerbatim(tree, line.from, line.to)) return null;
  const shape: Shape = { heading: 0, list: null, quotes: 0 };
  for (
    let node: SyntaxNode | null = tree.resolveInner(line.to, -1);
    node;
    node = node.parent
  ) {
    const heading = /^ATXHeading(\d)$/.exec(node.name);
    if (heading && shape.heading === 0 && shape.list === null) {
      shape.heading = Number(heading[1]);
    }
    if (node.name === "ListItem" && shape.list === null) {
      const task = node.getChild("Task") !== null;
      shape.list = task
        ? "task"
        : node.parent?.name === "OrderedList"
          ? "ordered"
          : "bullet";
    }
    if (node.name === "Blockquote") shape.quotes++;
  }
  return shape;
}

function hasShape(shape: Shape, id: LineConstruct["id"]): boolean {
  switch (id) {
    case "paragraph":
      return shape.heading === 0;
    case "bulletList":
      return shape.list === "bullet";
    case "orderedList":
      return shape.list === "ordered";
    case "taskList":
      return shape.list === "task";
    case "quote":
      return shape.quotes > 0;
    default:
      return shape.heading === Number(id.slice("heading".length));
  }
}
