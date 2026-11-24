// The list of a menu typed in the text: the
// / menu's, a link's headings'. Under the caret, the active option said to
// a screen reader from the text, which keeps the focus; a click chooses;
// leaving the text closes; Escape, the arrows, Enter and Tab before the
// editor's own keys, only while the menu is open.
import {
  type EditorState,
  type Extension,
  Prec,
  type StateEffectType,
  type StateField,
  type TransactionSpec,
} from "@codemirror/state";
import {
  type Command,
  EditorView,
  type Tooltip,
  ViewPlugin,
  keymap,
  showTooltip,
} from "@codemirror/view";

/** What a menu's state has for its list. */
export interface OpenMenu<T> {
  /** Where the typed text that opened it starts. */
  from: number;
  matches: readonly T[];
  /** The one Enter chooses, in `matches`. */
  active: number;
}

export interface MenuSpec<T, S extends OpenMenu<T>> {
  field: StateField<S | null>;
  /** The list's class, and its ids' start. */
  name: string;
  /** What a screen reader calls the list. */
  label: () => string;
  /** Fills an option for `item`: its text, maybe more. */
  option: (element: HTMLElement, item: T) => void;
  choose: (state: EditorState, item?: T) => TransactionSpec | null;
  close: (state: EditorState) => TransactionSpec;
  move: (state: EditorState, by: number) => TransactionSpec;
  /** The effect that closes it, when the text loses the focus. */
  closed: StateEffectType<null>;
}

/** How many options the list shows at once. */
const SHOWN = 10;

let lists = 0;

/** The list, its keys, and what it says from the text. */
export function menuList<T, S extends OpenMenu<T>>(
  spec: MenuSpec<T, S>,
): Extension {
  const { field, name } = spec;
  const stateOf = (state: EditorState) => state.field(field, false) ?? null;

  /** The id of a view's list, for its text's ARIA attributes. */
  const listId = ViewPlugin.define(() => ({ id: `oc-${name}-${++lists}` }));

  const listTooltip = (open: S): Tooltip => ({
    pos: open.from,
    above: false,
    create(view) {
      const dom = document.createElement("ul");
      dom.className = `cm-${name}`;
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", spec.label());
      dom.id = view.plugin(listId)?.id ?? "";
      // Ten at most, a window that follows the active one: the options
      // take no focus (the text keeps it), so the list may not scroll.
      const render = (state: S) => {
        const first = Math.max(
          0,
          Math.min(state.active - SHOWN + 1, state.matches.length - SHOWN),
        );
        dom.replaceChildren(
          ...state.matches.slice(first, first + SHOWN).map((item, offset) => {
            const index = first + offset;
            const option = document.createElement("li");
            option.id = `${dom.id}-${index}`;
            option.setAttribute("role", "option");
            option.setAttribute(
              "aria-selected",
              String(index === state.active),
            );
            option.setAttribute("aria-setsize", String(state.matches.length));
            option.setAttribute("aria-posinset", String(index + 1));
            spec.option(option, item);
            option.addEventListener("mousedown", (event) => {
              event.preventDefault();
              const chosen = spec.choose(view.state, item);
              if (chosen) view.dispatch(chosen);
            });
            return option;
          }),
        );
      };
      render(open);
      return {
        dom,
        update(update) {
          const now = stateOf(update.state);
          if (now && now !== stateOf(update.startState)) render(now);
        },
      };
    },
  });

  const tooltip = showTooltip.compute([field], (state) => {
    const open = state.field(field);
    return open ? listTooltip(open) : null;
  });

  /** As CodeMirror's completion says it (aria-expanded isn't allowed on a
   * textbox: axe, check:ui). */
  const textAttributes = EditorView.contentAttributes.of(
    (view): Record<string, string> => {
      const open = stateOf(view.state);
      const id = view.plugin(listId)?.id ?? "";
      if (!open) return {};
      return {
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        "aria-controls": id,
        "aria-activedescendant": `${id}-${open.active}`,
      };
    },
  );

  const blur = EditorView.focusChangeEffect.of((state, focusing) =>
    !focusing && stateOf(state) ? spec.closed.of(null) : null,
  );

  const whenOpen =
    (run: (state: EditorState) => TransactionSpec | null): Command =>
    (view) => {
      if (!stateOf(view.state)) return false;
      const chosen = run(view.state);
      if (chosen) view.dispatch(chosen);
      return true;
    };

  return [
    listId,
    tooltip,
    textAttributes,
    blur,
    theme(name),
    Prec.highest(
      keymap.of([
        { key: "Escape", run: whenOpen(spec.close) },
        { key: "ArrowDown", run: whenOpen((state) => spec.move(state, 1)) },
        { key: "ArrowUp", run: whenOpen((state) => spec.move(state, -1)) },
        { key: "Enter", run: whenOpen((state) => spec.choose(state)) },
        { key: "Tab", run: whenOpen((state) => spec.choose(state)) },
      ]),
    ),
  ];
}

/** Each menu's theme, made once: a theme made again for each editor would
 * add its style sheet to the document again. */
const themes = new Map<string, Extension>();

function theme(name: string): Extension {
  let made = themes.get(name);
  if (!made) {
    made = baseTheme(name);
    themes.set(name, made);
  }
  return made;
}

const baseTheme = (name: string) =>
  EditorView.baseTheme({
    // Over CodeMirror's own `&light .cm-tooltip`, which its tooltip gets.
    [`&.cm-editor .cm-tooltip.cm-${name}`]: {
      margin: "0",
      padding: "0.25rem",
      listStyle: "none",
      minWidth: "12rem",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--font-ui-size)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--radius-m)",
      background: "var(--paper-2)",
      color: "var(--ink)",
      boxShadow: "var(--shadow)",
    },
    [`&.cm-editor .cm-${name} [role=option]`]: {
      padding: "0.25rem 0.5rem",
      borderRadius: "var(--radius-s, 4px)",
      cursor: "pointer",
    },
    [`&.cm-editor .cm-${name} [aria-selected=true]`]: {
      background: "color-mix(in srgb, var(--ink) 12%, transparent)",
    },
  });
