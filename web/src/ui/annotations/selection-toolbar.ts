import { Prec, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { flushSync, mount } from "svelte";
import type { AnnotationType, Role } from "../../../lib/src/index.js";
import {
  type AdditionPlaces,
  additionPlaces,
  asOwnParagraph,
} from "../../editor/suggestion-place.js";
import { t } from "../../i18n/index.js";
import type { ViewSwitch } from "../reading/view-switch.js";
import Toolbar from "./SelectionToolbar.svelte";

/** Creates an annotation of `type` on the editor's selection (the panel's
 * `create`), an addition at `at`; returns an error to show, or nothing. */
export type Create = (
  type: AnnotationType,
  extra: string,
  note: string,
  at?: number,
) => string | undefined;

type Kind = "comment" | "suggest" | "delete";
type Place = "paragraph" | "inline";

/** The selection toolbar, drawn in `parent` next to
 * the selection: comment, suggest, delete. Never for a reader. A reviewer,
 * who cannot type, suggests an addition with the cursor alone; an editor
 * types it, or, in Review, suggests it as a reviewer does.
 * Ctrl+Alt+M comments the selection. What it creates goes
 * through `create`, exactly as the panel's own actions do. */
export function attachSelectionToolbar(
  view: EditorView,
  parent: HTMLElement,
  options: {
    role: Role;
    create: Create;
    /** The page's mode, where there is one. */
    views?: Pick<ViewSwitch, "mode" | "onMode">;
  },
): void {
  const { role, create, views } = options;
  // Who suggests at the cursor alone: a reviewer, an editor in Review.
  const atCursor = () =>
    role === "suggest" || (role === "edit" && views?.mode() === "review");
  if (role === "read") return;
  // What the composer was opened on: the selection may not move meanwhile.
  let captured: { from: number; to: number } | undefined;
  // Where an addition at the caret may go, when opened on one.
  let places: AdditionPlaces | null = null;
  // Right after creating, the toolbar stays away until the user selects.
  let resting = false;

  const selected = () => {
    const { from, to } = view.state.selection.main;
    return { from, to };
  };
  const close = () => {
    captured = undefined;
    places = null;
    toolbar.hide();
    flushSync();
    view.focus();
  };
  const done = () => {
    const at = captured?.to ?? selected().to;
    captured = undefined;
    places = null;
    resting = true;
    toolbar.hide();
    flushSync();
    view.dispatch({ selection: { anchor: at } });
    view.focus();
  };
  const compose = (kind: Kind) => {
    captured = selected();
    places =
      kind === "suggest" && captured.from === captured.to
        ? additionPlaces(view.state, captured.to)
        : null;
    toolbar.compose(
      kind,
      view.state.sliceDoc(captured.from, captured.to),
      places?.inline !== undefined ? places.preferred : undefined,
    );
    flushSync();
    place();
  };
  const mountToolbar = () =>
    mount(Toolbar, {
      target: parent,
      props: {
        onCompose: compose,
        onSubmit(kind: Kind, text: string, note: string, place?: Place) {
          const range = captured ?? selected();
          const original = view.state.sliceDoc(range.from, range.to);
          let problem: string | undefined;
          if (kind === "comment") {
            problem = text.trim()
              ? create("comment", text, "")
              : t().emptyComment;
          } else if (kind === "delete") {
            problem = create("deletion", "", note);
          } else if (range.from === range.to) {
            problem = addition(range.to, text, note, place);
          } else if (text === original) problem = t().nothingChanges;
          else if (text === "") problem = create("deletion", "", note);
          else problem = create("substitution", text, note);
          if (problem === undefined) done();
          return problem;
        },
        onClose: close,
      },
    });
  /** An addition at the caret `at`: as a paragraph of its own, or in the
   * line, after its markup; elsewhere, where it is. */
  const addition = (
    at: number,
    text: string,
    note: string,
    place: Place | undefined,
  ) => {
    if (places && (place ?? places.preferred) === "paragraph") {
      const where = places.paragraph;
      // Empty, it is refused as such, not as a line break.
      const proposed = text && asOwnParagraph(view.state.doc, where, text);
      return create("addition", proposed, note, where);
    }
    return create("addition", text, note, places?.inline ?? at);
  };
  // Mounted at its first showing, not at opening: most pages never
  // select anything, and mounting it cost more than the editor itself.
  let mounted: ReturnType<typeof mountToolbar> | undefined;
  const ensure = () => {
    mounted ??= mountToolbar();
    return mounted;
  };
  const toolbar = {
    hide: () => mounted?.hide(),
    isComposing: () => mounted?.isComposing() ?? false,
    root: () => mounted?.root(),
    show: (mode: "selection" | "cursor") => ensure().show(mode),
    compose: (kind: Kind, selected: string, place?: Place) =>
      ensure().compose(kind, selected, place),
    fail: (message: string) => ensure().fail(message),
  };

  // Whether the selection was last made with a finger: the system's
  // menu then opens above it (Android, iOS).
  let touch = false;
  view.dom.addEventListener("pointerdown", (event) => {
    touch = event.pointerType === "touch";
  });

  // Inside `parent`, which is positioned (`toolbarPosition`). Measured
  // by CodeMirror, between its own reads and writes.
  const place = () =>
    view.requestMeasure({
      read() {
        const element = toolbar.root();
        if (!element || element.hidden) return undefined;
        const range = captured ?? selected();
        let start: { top: number; bottom: number; left: number } | null;
        let end: { top: number; bottom: number; right: number } | null;
        try {
          start = view.coordsAtPos(range.from);
          end = view.coordsAtPos(range.to);
        } catch {
          return undefined; // no layout (jsdom)
        }
        if (!start || !end) return undefined;
        return toolbarPosition({
          start,
          end,
          box: parent.getBoundingClientRect(),
          height: element.offsetHeight,
          width: element.offsetWidth,
          touch,
        });
      },
      write(position) {
        const element = toolbar.root();
        if (!position || !element) return;
        element.style.top = `${position.top}px`;
        element.style.left = `${position.left}px`;
      },
    });

  const update = () => {
    if (toolbar.isComposing()) return;
    const { from, to } = selected();
    const inToolbar = toolbar.root()?.contains(document.activeElement);
    const empty = from === to;
    if (resting || (!view.hasFocus && !inToolbar) || (empty && !atCursor())) {
      toolbar.hide();
    } else {
      toolbar.show(empty ? "cursor" : "selection");
    }
    flushSync();
    place();
  };

  view.dispatch({
    effects: StateEffect.appendConfig.of([
      EditorView.updateListener.of((viewUpdate) => {
        if (viewUpdate.selectionSet) {
          // A selection elsewhere closes a composer opened on another.
          const now = selected();
          if (
            captured &&
            (now.from !== captured.from || now.to !== captured.to)
          ) {
            captured = undefined;
            places = null;
            toolbar.hide();
          }
          // The user's own selection ends the rest; our collapse after
          // creating, which carries no user event, doesn't.
          if (viewUpdate.transactions.some((tr) => tr.isUserEvent("select"))) {
            resting = false;
          }
        }
        if (viewUpdate.selectionSet || viewUpdate.focusChanged) update();
      }),
      Prec.high(
        keymap.of([
          {
            key: "Mod-Alt-m",
            run: () => {
              if (view.state.selection.main.empty) return false;
              compose("comment");
              return true;
            },
          },
        ]),
      ),
    ]),
  });
  // Into Review or out of it: the caret alone shows the toolbar or not.
  views?.onMode(update);
}

/** Below a selection made with a finger, clear of its handles (about
 * 22 px under the line on Android and iOS). */
const HANDLES = 28;

/** Where the toolbar goes, relative to its positioned parent `box`: with
 * a mouse, above the selection, else below it; with a finger, always
 * below, the system's menu (copy, paste…) opening above. Centred on the
 * selection, within the parent's width. */
export function toolbarPosition(at: {
  start: { top: number; left: number };
  end: { bottom: number; right: number };
  box: { top: number; left: number; width: number };
  height: number;
  width: number;
  touch: boolean;
}): { top: number; left: number } {
  const { start, end, box, height, width } = at;
  const above = start.top - box.top - height - 8;
  const below = end.bottom - box.top + (at.touch ? HANDLES : 8);
  const top = !at.touch && above >= 0 ? above : below;
  const middle = (start.left + end.right) / 2 - box.left - width / 2;
  const left = Math.max(0, Math.min(middle, box.width - width));
  return { top, left };
}
