// Moving a section from the editor: the page's
// editor binds it to Ctrl/Cmd+Shift+Up and Down, the plugin to two
// commands of Obsidian's. Any CodeMirror view: the page's or a host's.
import type { EditorView } from "@codemirror/view";
import { type Direction, moveSection } from "../outline/move-section.js";
import { outlineOfText } from "../outline/outline.js";

/** Moves the section the caret is in one place `direction`, in one
 * transaction, the caret where it was in the section; false when it
 * can't (no section, none of its level there, the text's meaning would
 * change) or the editor may not type. */
export function moveSectionBy(view: EditorView, direction: Direction): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const text = state.doc.toString();
  const headings = outlineOfText(text);
  const pos = state.selection.main.head;
  const move = moveSection(text, headings, pos, direction);
  if (!move) return false;
  const from = headings.filter((heading) => heading.from <= pos).at(-1)?.from;
  if (from === undefined) return false;
  view.dispatch({
    changes: move.changes,
    selection: { anchor: move.headingAt + (pos - from) },
    scrollIntoView: true,
    userEvent: "move.section",
  });
  return true;
}
