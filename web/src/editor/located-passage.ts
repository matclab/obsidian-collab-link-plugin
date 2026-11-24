// Where a card's annotated text stands today: the passage, or
// the point where its text was, marked while the card shows that text.
// Set at the click, by the range resolved there; then mapped through the
// edits, never resolved again.
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export interface Located {
  id: string;
  from: number;
  to: number;
}

/** Marks a passage (`null`: none). */
export const locate = StateEffect.define<Located | null>();

class PointWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const point = document.createElement("span");
    point.className = "cm-located-point";
    point.setAttribute("aria-hidden", "true");
    return point;
  }
}

const field = StateField.define<Located | null>({
  create: () => null,
  update(located, tr) {
    for (const effect of tr.effects) if (effect.is(locate)) return effect.value;
    if (!located || !tr.docChanged) return located;
    const from = tr.changes.mapPos(located.from, 1);
    const to = Math.max(from, tr.changes.mapPos(located.to, -1));
    return { ...located, from, to };
  },
  provide: (f) =>
    EditorView.decorations.from(f, (located) => {
      if (!located) return Decoration.none;
      if (located.from === located.to) {
        return Decoration.set(
          Decoration.widget({ widget: new PointWidget(), side: 1 }).range(
            located.from,
          ),
        );
      }
      return Decoration.set(
        Decoration.mark({ class: "cm-located" }).range(
          located.from,
          located.to,
        ),
      );
    }),
});

const theme = EditorView.theme({
  ".cm-located": {
    textDecoration: "underline dotted var(--pencil)",
    textDecorationThickness: "2px",
    textUnderlineOffset: "3px",
  },
  ".cm-located-point": {
    borderLeft: "2px solid var(--pencil)",
    marginLeft: "-1px",
    marginRight: "-1px",
  },
});

/** The extension: the marked passage and its look. */
export function locatedPassage(): Extension {
  return [field, theme];
}

/** The passage marked, if any. */
export function locatedAt(state: EditorState): Located | undefined {
  return state.field(field, false) ?? undefined;
}
