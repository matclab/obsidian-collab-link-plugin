import {
  EditorSelection,
  type EditorState,
  type Extension,
  type SelectionRange,
  findClusterBreak,
} from "@codemirror/state";
import { EditorView, type MouseSelectionStyle } from "@codemirror/view";

/** A first press: where it was on screen, and in the text. */
export interface Press {
  x: number;
  y: number;
  pos: number;
  assoc: -1 | 1;
}

/** How far, in pixels, a press may be from the first one to take its
 * position. */
const SLOP = 4;

/** Whether `event` is at the spot of `first`. */
export function sameSpot(
  first: Press | undefined,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): boolean {
  return (
    first !== undefined &&
    Math.abs(event.clientX - first.x) <= SLOP &&
    Math.abs(event.clientY - first.y) <= SLOP
  );
}

/** What `clicks` presses at `pos` select: the word, or the run of spaces
 * or punctuation (two), the line and its break (three) — CodeMirror's
 * `rangeForClick`, on the document's line rather than the drawn one. */
export function clickRange(
  state: EditorState,
  pos: number,
  assoc: -1 | 1,
  clicks: number,
): SelectionRange {
  const line = state.doc.lineAt(pos);
  if (clicks >= 3) {
    const to = line.to < state.doc.length ? line.to + 1 : line.to;
    return EditorSelection.range(line.from, to);
  }
  if (line.length === 0) return EditorSelection.cursor(pos);
  const at = pos - line.from;
  const bias = at === 0 ? 1 : at === line.length ? -1 : assoc;
  const categorize = state.charCategorizer(pos);
  let from = at;
  let to = at;
  if (bias < 0) from = findClusterBreak(line.text, at, false);
  else to = findClusterBreak(line.text, at);
  const kind = categorize(line.text.slice(from, to));
  while (from > 0) {
    const previous = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(previous, from)) !== kind) break;
    from = previous;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== kind) break;
    to = next;
  }
  return EditorSelection.range(from + line.from, to + line.from);
}

/** A double or triple click selects what was under the pointer at the
 * first press: that press moves the caret, which may reveal the line's
 * markup (live formatting), the text then moving under the pointer, and
 * CodeMirror would read the next presses on it. Dragging on extends by
 * words or lines from there, to where the pointer is on the text as it is
 * now. Otherwise CodeMirror's own selection (`basicMouseSelection`,
 * copied here as of @codemirror/view 6.43.13: to compare at each update). */
export function multiClicks(): Extension {
  let first: Press | undefined;
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.detail <= 1) {
      const { pos, assoc } = view.posAndSideAtCoords(
        { x: event.clientX, y: event.clientY },
        false,
      );
      first = { x: event.clientX, y: event.clientY, pos, assoc };
      return null;
    }
    if (event.button !== 0 || !sameSpot(first, event) || !first) return null;
    return fromFirst(view, first, event.detail);
  });
}

function fromFirst(
  view: EditorView,
  press: Press,
  clicks: number,
): MouseSelectionStyle {
  let start = { pos: press.pos, assoc: press.assoc };
  let startSel = view.state.selection;
  return {
    update(update) {
      if (!update.docChanged) return;
      start = { ...start, pos: update.changes.mapPos(start.pos) };
      startSel = startSel.map(update.changes);
    },
    get(event, extend, multiple) {
      const cur = sameSpot(press, event)
        ? start
        : view.posAndSideAtCoords(
            { x: event.clientX, y: event.clientY },
            false,
          );
      let range = clickRange(view.state, cur.pos, cur.assoc, clicks);
      if (cur.pos !== start.pos && !extend) {
        const startRange = clickRange(
          view.state,
          start.pos,
          start.assoc,
          clicks,
        );
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range =
          from < range.from
            ? EditorSelection.range(from, to)
            : EditorSelection.range(to, from);
      }
      if (extend)
        return startSel.replaceRange(
          startSel.main.extend(range.from, range.to),
        );
      if (multiple) return startSel.addRange(range);
      return EditorSelection.create([range]);
    },
  };
}
