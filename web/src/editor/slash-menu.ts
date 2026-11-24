// The / menu (ADR-0046 §4): a / typed at a line's
// start or after a space lists the constructions; what follows filters
// them. The text is the text as typed: nothing is held back, and a close
// changes nothing — `/home/me` stays `/home/me`. A choice replaces the
// typed /… by the construction, in one transaction. Its state is
// CodeMirror's: its position follows every change, the user's or
// another's (interleavings 1 to 7).
import {
  type ChangeSpec,
  type EditorState,
  type Extension,
  MapMode,
  StateEffect,
  StateField,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { t } from "../i18n/index.js";
import { count } from "../perf/index.js";
import { CALLOUT_FAMILIES, type CalloutFamily } from "../render/index.js";
import { anchorState } from "./anchor-menu.js";
import {
  calloutName,
  calloutNames,
  calloutTitle,
  constructName,
  constructNames,
} from "./construct-name.js";
import { CONSTRUCTS, type ConstructId } from "./constructs.js";
import {
  calloutTransaction,
  constructTransaction,
  inCodeAt,
} from "./format-commands.js";
import { mayInsertImage, pickImage } from "./image-insertion.js";
import { type OpenMenu, menuList } from "./menu-list.js";

/** What the menu lists: a construction, or a callout of a family
 * (ADR-0063, EN1). */
export type SlashItem = ConstructId | `callout:${CalloutFamily}`;

export interface SlashState extends OpenMenu<SlashItem> {
  /** What was typed after the /, up to the caret. */
  query: string;
}

/** What the menu offers: the catalogue but plain text, which is no
 * construction to insert. */
const OFFERED = CONSTRUCTS.map((each) => each.id).filter(
  (id) => id !== "paragraph",
);

/** What `state`'s menu offers: an image only where one may be inserted. */
const offered = (state: EditorState, items: readonly SlashItem[]) =>
  mayInsertImage(state) ? items : items.filter((item) => item !== "image");

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The constructions whose names hold `query`, in the catalogue's order;
 * at a callout's place, the families looked for (EN2): none without a
 * query, all when a callout is the only construction left, else, from two
 * letters or when no construction is left, those with a word of a name
 * starting with it. */
export function slashMatches(query: string): readonly SlashItem[] {
  const wanted = fold(query);
  const ids = OFFERED.filter((id) =>
    constructNames(id).some((name) => fold(name).includes(wanted)),
  );
  const alone = ids.length === 1 && ids[0] === "callout";
  // One letter: only where no construction is left, or the menu would
  // close before a family's name is typed.
  const starts = (family: CalloutFamily) =>
    (wanted.length >= 2 || ids.length === 0) &&
    calloutNames(family).some((name) =>
      fold(name)
        .split(/[\s-]+/)
        .some((word) => word.startsWith(wanted)),
    );
  const families =
    wanted === ""
      ? []
      : CALLOUT_FAMILIES.filter((family) => alone || starts(family));
  return OFFERED.flatMap((id): SlashItem[] => [
    ...(ids.includes(id) ? [id] : []),
    ...(id === "callout"
      ? families.map((family): SlashItem => `callout:${family}`)
      : []),
  ]);
}

const familyOf = (item: SlashItem) =>
  item.startsWith("callout:")
    ? (item.slice("callout:".length) as CalloutFamily)
    : null;

/** An item applied where the caret is: what a choice does once the /…
 * is out. */
export function slashTransaction(
  state: EditorState,
  item: SlashItem,
): TransactionSpec | null {
  const family = familyOf(item);
  return family
    ? calloutTransaction(state, family, calloutTitle(family))
    : constructTransaction(state, item as ConstructId);
}

const close = StateEffect.define<null>();
const move = StateEffect.define<number>();

/** A / just typed by the user at a line's start or after a space, out of
 * code: where it is. */
function opened(tr: Transaction): number | null {
  if (!tr.isUserEvent("input.type") || !tr.docChanged) return null;
  // A / in a heading's name, while a link's menu is open: its query.
  if (anchorState(tr.startState)) return null;
  const inserted: number[] = [];
  let changes = 0;
  tr.changes.iterChanges((fromA, toA, fromB, _toB, text) => {
    changes++;
    if (fromA === toA && text.toString() === "/") inserted.push(fromB);
  });
  const at = inserted[0];
  if (changes !== 1 || at === undefined) return null;
  const { state } = tr;
  const head = state.selection.main;
  if (!head.empty || head.head !== at + 1) return null;
  const line = state.doc.lineAt(at);
  const before = at === line.from ? "" : state.sliceDoc(at - 1, at);
  if (before !== "" && !/\s/.test(before)) return null;
  // In code, a formula or the YAML header, a / is text.
  count("slash.open");
  return inCodeAt(state, at) ? null : at;
}

const field = StateField.define<SlashState | null>({
  create: () => null,
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(close))) return null;
    if (!value) {
      const at = opened(tr);
      return at === null
        ? null
        : {
            from: at,
            query: "",
            matches: offered(tr.state, OFFERED),
            active: 0,
          };
    }
    // The caret moved, the text unchanged: out of what was typed, even
    // forward over text already there.
    if (tr.selection && !tr.docChanged) return null;
    let { from } = value;
    if (tr.docChanged) {
      const mapped = tr.changes.mapPos(from, 1, MapMode.TrackDel);
      if (mapped === null) return null;
      // Another's change, or the editor's own (a decision, a restore), in
      // what was typed: a choice would replace more than the user's.
      const end = from + 1 + value.query.length;
      const typed = tr.isUserEvent("input") || tr.isUserEvent("delete");
      if (!typed && tr.changes.touchesRange(from + 1, end)) return null;
      from = mapped;
    }
    const { state } = tr;
    if (state.sliceDoc(from, from + 1) !== "/") return null;
    const head = state.selection.main;
    if (!head.empty || head.head <= from) return null;
    // Over a line break, nothing matches: closed below.
    const query = state.sliceDoc(from + 1, head.head);
    // A space right after the /: the / was text (as in Obsidian).
    if (/^\s/.test(query)) return null;
    const matches =
      query === value.query
        ? value.matches
        : offered(state, slashMatches(query));
    if (matches.length === 0) return null;
    let active = query === value.query ? value.active : 0;
    for (const effect of tr.effects) {
      if (effect.is(move)) {
        active = (active + effect.value + matches.length * 2) % matches.length;
      }
    }
    return { from, query, matches, active };
  },
});

export function slashState(state: EditorState): SlashState | null {
  return state.field(field, false) ?? null;
}

/** Closes the menu; the text as it is. */
export function closeSlash(_state: EditorState): TransactionSpec {
  return { effects: close.of(null) };
}

/** The choice `by` places further, round the matches. */
export function moveSlash(_state: EditorState, by: number): TransactionSpec {
  return { effects: move.of(by) };
}

/** The choice made: the typed /… taken out and the construction applied
 * where it was, as one transaction (one undo gives the /… back). Null
 * when the menu is closed; the menu closed, nothing else, when the
 * construction can't be applied there. */
export function chooseSlash(
  state: EditorState,
  id?: SlashItem,
): TransactionSpec | null {
  const open = slashState(state);
  if (!open) return null;
  const chosen = id ?? open.matches[open.active];
  if (!chosen) return null;
  const typed: ChangeSpec = {
    from: open.from,
    to: open.from + 1 + open.query.length,
  };
  const without = state.update({
    changes: typed,
    selection: { anchor: open.from },
  }).state;
  const spec = slashTransaction(without, chosen);
  // An image is asked for once the /… is out: the inserter puts it there.
  if (chosen === "image" && spec?.effects) {
    return {
      changes: typed,
      selection: { anchor: open.from },
      effects: [close.of(null), pickImage.of(null)],
      userEvent: "input.format",
    };
  }
  if (!spec?.changes) return closeSlash(state);
  const changes = state.changes(typed).compose(without.changes(spec.changes));
  return {
    changes,
    ...(spec.selection !== undefined && { selection: spec.selection }),
    effects: close.of(null),
    scrollIntoView: true,
    userEvent: "input.format",
  };
}

/** The menu's state and its list. */
export function slashMenu(): Extension {
  return [
    field,
    menuList<SlashItem, SlashState>({
      field,
      name: "slash-menu",
      label: () => t().insert,
      option: (element, item) => {
        const family = familyOf(item);
        element.textContent = family
          ? t().calloutItem(calloutName(family))
          : constructName(item as ConstructId);
      },
      choose: chooseSlash,
      close: closeSlash,
      move: moveSlash,
      closed: close,
    }),
  ];
}
