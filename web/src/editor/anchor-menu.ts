// The menu of a link to a heading: a # typed right
// after `](` or `[[` lists the document's headings; what follows filters
// them. As the / menu (decision 4), the text is the text as typed and a
// close changes nothing; a choice replaces the typed #… by the heading as
// Obsidian writes it (`anchor-choices.ts`), the link closed if it wasn't,
// in one transaction. Its position follows every change, the user's or
// another's (interleavings 1 to 7). The headings are the
// view's outline (`anchorHeadings`), read when the text changes while it
// is open; nothing read while it is closed.
import {
  type EditorState,
  type Extension,
  Facet,
  MapMode,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { t } from "../i18n/index.js";
import {
  type AnchorChoice,
  type AnchorForm,
  anchorChoices,
  anchorMatches,
} from "../outline/anchor-choices.js";
import type { OutlineHeading } from "../outline/outline.js";
import { count } from "../perf/index.js";
import { inCodeAt } from "./format-commands.js";
import { type OpenMenu, menuList } from "./menu-list.js";

/** The document's headings now; the view adds its outline's. */
export const anchorHeadings = Facet.define<() => readonly OutlineHeading[]>();

export interface AnchorState extends OpenMenu<AnchorChoice> {
  /** Where the # is. */
  from: number;
  form: AnchorForm;
  /** What was typed after the #, up to the caret. */
  query: string;
}

/** What opens it, right before the #. */
const OPENING: Record<AnchorForm, string> = { link: "](", wikilink: "[[" };

/** What closes the link, after its fragment. */
const CLOSING: Record<AnchorForm, string> = { link: ")", wikilink: "]]" };

/** What, typed after the #, ends the link or makes it another: a path's
 * #, a line break; in a link, a parenthesis, a bracket, an angle bracket;
 * in a `[[…]]`, a bracket or its alias's `|`. */
const ENDS: Record<AnchorForm, RegExp> = {
  link: /[#()[\]<>\n]/,
  wikilink: /[#[\]|\n]/,
};

const close = StateEffect.define<null>();
const move = StateEffect.define<number>();

function matchesIn(
  state: EditorState,
  form: AnchorForm,
  query: string,
): readonly AnchorChoice[] {
  const headings = state.facet(anchorHeadings)[0];
  if (!headings) return [];
  return anchorMatches(anchorChoices(headings(), form), query);
}

/** A # just typed by the user right after `](` or `[[` (not `![[`), out
 * of code: where it is, and the link's form. */
function opened(tr: Transaction): { at: number; form: AnchorForm } | null {
  if (!tr.isUserEvent("input.type") || !tr.docChanged) return null;
  const inserted: number[] = [];
  let changes = 0;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, text) => {
    changes++;
    if (fromA === toA && text.toString() === "#") inserted.push(fromB);
  });
  const at = inserted[0];
  if (changes !== 1 || at === undefined || at < 2) return null;
  const { state } = tr;
  const head = state.selection.main;
  if (!head.empty || head.head !== at + 1) return null;
  const before = state.sliceDoc(at - 3, at);
  const form: AnchorForm | null = before.endsWith(OPENING.link)
    ? "link"
    : before.endsWith(OPENING.wikilink) && before !== "![["
      ? "wikilink"
      : null;
  if (!form) return null;
  // In code, a formula or the YAML header, a # is text.
  count("anchor.open");
  return inCodeAt(state, at) ? null : { at, form };
}

const field = StateField.define<AnchorState | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(close))) return null;
    if (!value) {
      const open = opened(tr);
      if (!open) return null;
      const matches = matchesIn(tr.state, open.form, "");
      return matches.length === 0
        ? null
        : { from: open.at, form: open.form, query: "", matches, active: 0 };
    }
    // The caret moved, the text unchanged: out of what was typed, even
    // forward over text already there.
    if (tr.selection && !tr.docChanged) return null;
    let { from } = value;
    const { form } = value;
    if (tr.docChanged) {
      const mapped = tr.changes.mapPos(from, 1, MapMode.TrackDel);
      if (mapped === null) return null;
      // Another's change, or the editor's own (a decision, a restore), in
      // what was typed: a choice would replace more than the user's. What
      // opened it is looked at below.
      const end = from + 1 + value.query.length;
      const typed = tr.isUserEvent("input") || tr.isUserEvent("delete");
      if (!typed && tr.changes.touchesRange(from + 1, end)) return null;
      from = mapped;
    }
    const { state } = tr;
    if (state.sliceDoc(from - 2, from + 1) !== `${OPENING[form]}#`) return null;
    const head = state.selection.main;
    if (!head.empty || head.head <= from) return null;
    const query = state.sliceDoc(from + 1, head.head);
    if (ENDS[form].test(query)) return null;
    // The headings may have changed with the text: read again.
    const matches = tr.docChanged
      ? matchesIn(state, form, query)
      : value.matches;
    if (matches.length === 0) return null;
    let active =
      query === value.query ? Math.min(value.active, matches.length - 1) : 0;
    for (const effect of tr.effects) {
      if (effect.is(move)) {
        active = (active + effect.value + matches.length * 2) % matches.length;
      }
    }
    return { from, form, query, matches, active };
  },
});

export function anchorState(state: EditorState): AnchorState | null {
  return state.field(field, false) ?? null;
}

/** Closes the menu; the text as it is. */
export function closeAnchor(_state: EditorState): TransactionSpec {
  return { effects: close.of(null) };
}

/** The choice `by` places further, round the matches. */
export function moveAnchor(_state: EditorState, by: number): TransactionSpec {
  return { effects: move.of(by) };
}

/** The choice made: the typed #… replaced by `#` and the heading, the link
 * closed if what follows doesn't, the caret after it, as one transaction
 * (one undo gives the #… back). Null when the menu is closed. */
export function chooseAnchor(
  state: EditorState,
  choice?: AnchorChoice,
): TransactionSpec | null {
  const open = anchorState(state);
  if (!open) return null;
  const chosen = choice ?? open.matches[open.active];
  if (!chosen) return null;
  const end = open.from + 1 + open.query.length;
  const closing = CLOSING[open.form];
  const closed = state.sliceDoc(end, end + closing.length) === closing;
  const insert = chosen.fragment + (closed ? "" : closing);
  return {
    changes: { from: open.from + 1, to: end, insert },
    selection: {
      anchor: open.from + 1 + chosen.fragment.length + closing.length,
    },
    effects: close.of(null),
    scrollIntoView: true,
    userEvent: "input.complete",
  };
}

/** The menu's state and its list: the heading's text, set in by its
 * level. */
export function anchorMenu(): Extension {
  return [
    field,
    menuList<AnchorChoice, AnchorState>({
      field,
      name: "anchor-menu",
      label: () => t().anchorMenu,
      option: (element, choice) => {
        element.textContent = choice.text;
        element.dataset.level = String(choice.level);
      },
      choose: chooseAnchor,
      close: closeAnchor,
      move: moveAnchor,
      closed: close,
    }),
    levels,
  ];
}

const levels = EditorView.baseTheme(
  Object.fromEntries(
    [2, 3, 4, 5, 6].map((level) => [
      `&.cm-editor .cm-anchor-menu [data-level="${level}"]`,
      { paddingInlineStart: `${0.5 + (level - 1) * 0.75}rem` },
    ]),
  ),
);
