import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type {
  AnnotationIndex,
  Presence,
  RemotePresence,
} from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import { count } from "../perf/index.js";
import { liveReveal, revealSource } from "./live-reveal.js";

const setCursors =
  StateEffect.define<(RemotePresence & { attested?: boolean })[]>();

/** How a presence is named on its caret. */
export interface CursorNames {
  name(other: RemotePresence): { name: string; attested: boolean };
  subscribe(listener: () => void): () => void;
}

/** Per view: its cursors' refresh, and how they are named. */
const named = new WeakMap<
  EditorView,
  { refresh: () => void; names?: CursorNames | undefined }
>();

/** A caret, with the name above it: attested, or the one chosen. */
class Caret extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
    readonly attested = false,
  ) {
    super();
  }

  override eq(other: Caret): boolean {
    return (
      other.name === this.name &&
      other.color === this.color &&
      other.attested === this.attested
    );
  }

  toDOM(): HTMLElement {
    // A bar of no width, the name floating above it: the text doesn't
    // move (index.html).
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderLeftColor = this.color;
    caret.title = this.attested
      ? t().cursorVerified(this.name)
      : t().cursorNotVerified(this.name);
    // Not read in the text: who is here, the list of those present says
    //.
    caret.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "cm-remote-name";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A presence as its caret shows it: the attested name, if it is. */
type Shown = RemotePresence & { attested?: boolean };

function build(others: Shown[], length: number): DecorationSet {
  const ranges = [];
  for (const { name, color, anchor, head, attested } of others) {
    if (head === undefined) continue; // not resolvable yet (R-P4)
    const at = Math.min(head, length);
    if (anchor !== undefined && anchor !== head) {
      const from = Math.min(anchor, at, length);
      const to = Math.min(Math.max(anchor, at), length);
      if (to > from) {
        ranges.push(
          Decoration.mark({
            class: "cm-remote-selection",
            attributes: { style: `background-color: ${color}33` },
          }).range(from, to),
        );
      }
    }
    ranges.push(
      Decoration.widget({
        widget: new Caret(name, color, attested),
        side: 1,
      }).range(at),
    );
  }
  return Decoration.set(ranges, true);
}

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(cursors, transaction) {
    // Between two resolutions, the carets follow the text like any
    // decoration: through local typing and remote changes alike.
    let next = cursors.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setCursors)) {
        next = build(effect.value, transaction.state.doc.length);
      }
    }
    return next;
  },
  provide: (self) => EditorView.decorations.from(self),
});

const noPositions: readonly number[] = [];
const positionsOf = new WeakMap<DecorationSet, readonly number[]>();

/** Where the others' carets and selections stand in `state` (ADR-0055
 * §12): the same array while they don't move. */
export function remoteCaretPositions(state: EditorState): readonly number[] {
  const cursors = state.field(field, false);
  if (!cursors || cursors.size === 0) return noPositions;
  let positions = positionsOf.get(cursors);
  if (!positions) {
    const found: number[] = [];
    cursors.between(0, state.doc.length, (from, to) => {
      found.push(from, to);
    });
    positions = found;
    positionsOf.set(cursors, positions);
  }
  return positions;
}

/** Shows the others' cursors in `view` (ADR-0025 §7). They are resolved
 * when a state arrives that changes what they show (R-P7), and after a
 * change of the docs (`index`: never the editor's own typing) only while
 * one doesn't resolve yet (R-P4). Returns a stop. */
export function attachRemoteCursors(
  view: EditorView,
  presence: Presence,
  index: Pick<AnnotationIndex, "subscribe">,
): () => void {
  let unresolved = false;
  let shown: number | undefined;
  const refresh = () => {
    count("presence.resolve");
    shown = presence.shown();
    const others = presence.others();
    unresolved = others.some((other) => other.head === undefined);
    const names = named.get(view)?.names;
    view.dispatch({
      effects: setCursors.of(
        names
          ? others.map((other) => ({ ...other, ...names.name(other) }))
          : others,
      ),
    });
  };
  named.set(view, { refresh });
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      field as Extension,
      // Live formatting keeps each caret and selection in sight.
      liveReveal.compute([field], (state) =>
        revealSource(state.field(field), () => "cursor"),
      ),
    ]),
  });
  const stops = [
    presence.subscribe(() => {
      if (presence.shown() !== shown) refresh();
    }),
    index.subscribe(() => {
      if (unresolved) refresh();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/** Names the cursors of `view` by `names`: the attested
 * name of a presence that is, as the list of those present shows it;
 * shown again whenever `names` changes. Returns a stop. */
export function nameRemoteCursors(
  view: EditorView,
  names: CursorNames,
): () => void {
  const entry = named.get(view);
  if (!entry) return () => {};
  entry.names = names;
  const stop = names.subscribe(() => entry.refresh());
  entry.refresh();
  return () => {
    stop();
    if (entry.names === names) entry.names = undefined;
  };
}
