// The Tab key in the page's editor (ADR-0054): as Obsidian, it indents.
// In a list, an item goes one level down or up with its children; lines
// selected go in or out by a level; elsewhere, Tab inserts a tab. Pure:
// a state and a direction, a transaction or nothing.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type {
  ChangeSpec,
  EditorState,
  Line,
  StateCommand,
  TransactionSpec,
} from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

const PARSE_BUDGET_MS = 50;
/** A quote's marks before a line's own text. */
const QUOTE_MARKS = /^(?:[ ]{0,3}>[ ]?)*/;
/** The columns a level takes: a tab, or up to four spaces. */
const LEVEL = 4;

/** What Tab (`1`) or Shift+Tab (`-1`) changes; null when nothing does
 * (the key is taken all the same: it doesn't leave the text). */
export function indentChange(
  state: EditorState,
  by: 1 | -1,
): TransactionSpec | null {
  const tree =
    ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ??
    syntaxTree(state);
  const { main } = state.selection;
  const first = state.doc.lineAt(main.from);
  const last = lastLine(state, main.from, main.to);
  if (first.number === last.number) {
    const item = itemOn(tree, state, first);
    if (item)
      return by > 0 ? indentItem(state, item) : outdentItem(state, item);
    if (main.empty && by > 0) {
      return {
        changes: { from: main.from, insert: "\t" },
        selection: { anchor: main.from + 1 },
        scrollIntoView: true,
        userEvent: "input.indent",
      };
    }
  }
  // The lines touched, an item's children with the line that starts it.
  const numbers = new Set<number>();
  for (let n = first.number; n <= last.number; n++) {
    numbers.add(n);
    const item = itemStarting(tree, state, state.doc.line(n));
    if (item) for (const m of itemLines(state, item)) numbers.add(m);
  }
  const lines = [...numbers]
    .sort((a, b) => a - b)
    .map((n) => state.doc.line(n));
  return by > 0 ? indentLines(lines) : outdentLines(lines, LEVEL);
}

/** Tab and Shift+Tab, in an editable text; a read-only one leaves the key
 * to the browser (ADR-0054 §5). */
export function indentCommand(by: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const spec = indentChange(state, by);
    if (spec) dispatch(state.update(spec));
    return true;
  };
}

/** The last line a selection touches: not the one it ends at the start of. */
function lastLine(state: EditorState, from: number, to: number): Line {
  const line = state.doc.lineAt(to);
  return to > from && to === line.from ? state.doc.line(line.number - 1) : line;
}

/** Where a line's own text starts: past a quote's marks. */
function textStart(line: Line): number {
  return line.from + (QUOTE_MARKS.exec(line.text)?.[0].length ?? 0);
}

/** Whether nothing but a quote's marks and blank is on the line. */
function blankLine(line: Line): boolean {
  return line.text.slice(textStart(line) - line.from).trim() === "";
}

/** Where its first non-blank character is, past a quote's marks. */
function firstVisible(line: Line): number {
  const from = textStart(line) - line.from;
  const blank = /^[ \t]*/.exec(line.text.slice(from))?.[0].length ?? 0;
  return line.from + from + blank;
}

/** The innermost list item `line` is in, if any. */
function itemOn(tree: Tree, state: EditorState, line: Line): SyntaxNode | null {
  if (blankLine(line)) return null;
  for (
    let node: SyntaxNode | null = tree.resolveInner(firstVisible(line), 1);
    node;
    node = node.parent
  ) {
    if (node.name === "ListItem") return node;
  }
  return null;
}

/** The list item `line` starts, if it starts one. */
function itemStarting(
  tree: Tree,
  state: EditorState,
  line: Line,
): SyntaxNode | null {
  const item = itemOn(tree, state, line);
  return item && state.doc.lineAt(item.from).number === line.number
    ? item
    : null;
}

/** The numbers of an item's lines, its children's included. */
function itemLines(state: EditorState, item: SyntaxNode): number[] {
  const first = state.doc.lineAt(item.from).number;
  const last = lastLine(state, item.from, item.to).number;
  const numbers: number[] = [];
  for (let n = first; n <= last; n++) numbers.push(n);
  return numbers;
}

/** One level down: under the item before it, which it must have. A tab,
 * if it reaches the column of that item's text; else spaces, as many as
 * it takes — tabs stop every four columns from the line's start, and a
 * quote's `> ` or a long number leaves a tab short. */
function indentItem(
  state: EditorState,
  item: SyntaxNode,
): TransactionSpec | null {
  // In a quote, its marks stand between the items.
  let before = item.prevSibling;
  while (before?.name === "QuoteMark") before = before.prevSibling;
  if (before?.name !== "ListItem") return null;
  const lines = itemLines(state, item).map((n) => state.doc.line(n));
  const first = state.doc.lineAt(item.from);
  const head = state.sliceDoc(first.from, textStart(first));
  const blank = state.sliceDoc(textStart(first), firstVisible(first));
  const target = textColumn(state, before);
  let level = "\t";
  for (let n = 1; columns(head + level + blank) < target; n++) {
    level = " ".repeat(n);
  }
  const spec = indentLines(lines, level);
  if (!spec) return null;
  // The first of a numbered list under its sibling starts at 1.
  const one = /List$/.test(before.lastChild?.name ?? "")
    ? null
    : startingAtOne(state, item);
  return one ? { ...spec, changes: [spec.changes, one] as ChangeSpec[] } : spec;
}

/** The change that numbers `item` 1, if it is numbered otherwise: the
 * first item of a list under another's paragraph must be, or it is that
 * paragraph's text (CommonMark). */
function startingAtOne(
  state: EditorState,
  item: SyntaxNode,
): ChangeSpec | null {
  const mark = item.getChild("ListMark");
  const number = mark && /^\d+/.exec(state.sliceDoc(mark.from, mark.to));
  if (!mark || !number || number[0] === "1") return null;
  return { from: mark.from, to: mark.from + number[0].length, insert: "1" };
}

/** The node after `node`, a quote's marks skipped (they stand between
 * the items). */
function nextOf(node: SyntaxNode): SyntaxNode | null {
  let after = node.nextSibling;
  while (after?.name === "QuoteMark") after = after.nextSibling;
  return after;
}

/** The item after `item` in its parent: in its list, or the first of a
 * list right after it (`1)` then `2.`: two lists), if any. */
function nextItem(item: SyntaxNode): SyntaxNode | null {
  const after = nextOf(item);
  if (after) return after.name === "ListItem" ? after : null;
  const list = item.parent && nextOf(item.parent);
  return list && /List$/.test(list.name) ? list.getChild("ListItem") : null;
}

/** One level up: beside the item it is in, which it must be in. */
function outdentItem(
  state: EditorState,
  item: SyntaxNode,
): TransactionSpec | null {
  const parent = item.parent?.parent;
  if (parent?.name !== "ListItem") return null;
  // Measured at their marks: an item may start before its own, where a
  // quote's `> ` takes part of a tab.
  const markAt = (node: SyntaxNode) =>
    columnAt(state, node.getChild("ListMark")?.from ?? node.from);
  const level = markAt(item) - markAt(parent);
  const lines = itemLines(state, item).map((n) => state.doc.line(n));
  const spec = outdentLines(lines, level);
  if (!spec) return null;
  // The items after it become its children: the first of them starts a
  // list under its paragraph, at 1 — unless it has children already.
  const after = nextItem(item);
  const one =
    after && !/List$/.test(item.lastChild?.name ?? "")
      ? startingAtOne(state, after)
      : null;
  return one ? { ...spec, changes: [spec.changes, one] as ChangeSpec[] } : spec;
}

/** `level` at the start of each line's own text, blank lines left as
 * they are. */
function indentLines(
  lines: readonly Line[],
  level = "\t",
): TransactionSpec | null {
  const changes = lines
    .filter((line) => !blankLine(line))
    .map((line) => ({ from: textStart(line), insert: level }));
  if (changes.length === 0) return null;
  return { changes, scrollIntoView: true, userEvent: "input.indent" };
}

/** Each line's own text moved `level` columns left, or as far as its
 * blank goes: the shortest start of that blank taken off — a tab taken off
 * moves the tabs after it to other stops. */
function outdentLines(
  lines: readonly Line[],
  level: number,
): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    const from = textStart(line);
    const head = line.text.slice(0, from - line.from);
    const blank = /^[ \t]*/.exec(line.text.slice(from - line.from))?.[0] ?? "";
    const target = columns(head + blank) - level;
    let taken = 0;
    while (
      taken < blank.length &&
      columns(head + blank.slice(taken)) > target
    ) {
      taken++;
    }
    if (taken > 0) changes.push({ from, to: from + taken });
  }
  if (changes.length === 0) return null;
  return { changes, scrollIntoView: true, userEvent: "delete.dedent" };
}

/** The column of `pos`, from its line's start. */
function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return columns(line.text.slice(0, pos - line.from));
}

/** The column where an item's text starts: past its mark and the spaces
 * after it, or one past its mark if they are more than four columns
 * (CommonMark: then the text is indented code). */
function textColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild("ListMark");
  if (!mark) return columnAt(state, item.from);
  const line = state.doc.lineAt(mark.to);
  const after = /^[ \t]*/.exec(line.text.slice(mark.to - line.from))?.[0] ?? "";
  const end = columnAt(state, mark.to);
  const text = columns(line.text.slice(0, mark.to - line.from) + after);
  return text - end > 4 || text === end ? end + 1 : text;
}

/** The columns `text` takes, a tab going to the next multiple of four. */
function columns(text: string): number {
  let width = 0;
  for (const char of text) width = next(width, char);
  return width;
}

function next(width: number, char: string): number {
  return char === "\t" ? (Math.floor(width / LEVEL) + 1) * LEVEL : width + 1;
}
