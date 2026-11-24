import { history } from "@codemirror/commands";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { EditorFactory } from "../editor.js";

/** An editor provided as Obsidian builds its own (phase 17, analysis 17d,
 * I8): its history, and its `readOnly.of(false)` (in a compartment, for
 * `setReadonly`) and `exceptionSink.of(console.error)` before the view's
 * extensions; in an element of its own, in the one given. */
export const obsidianLike: EditorFactory = (parent, setup) => {
  // Obsidian's editor is in an element of its own, in the one given.
  const element = document.createElement("div");
  element.className = "markdown-source-view";
  parent.append(element);
  const view = new EditorView({
    state: EditorState.create({
      doc: setup.doc,
      extensions: [
        EditorView.exceptionSink.of(console.error),
        history(),
        new Compartment().of(EditorState.readOnly.of(false)),
        ...setup.extensions,
      ],
    }),
    parent: element,
  });
  return {
    view,
    element,
    destroy: () => {
      view.destroy();
      element.remove();
    },
  };
};

class Drawn extends WidgetType {
  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "drawn";
    return div;
  }
}

/** Obsidian's editor, as `obsidianLike`, drawing `[from, to]` as a block
 * in place of its text: a callout, its caret elsewhere (its live preview;
 * choice/obsidian/blocks). */
export const obsidianDrawing =
  (from: number, to: number): EditorFactory =>
  (parent, setup) =>
    obsidianLike(parent, {
      ...setup,
      extensions: [
        StateField.define<DecorationSet>({
          create: () =>
            Decoration.set(
              Decoration.replace({ widget: new Drawn(), block: true }).range(
                from,
                to,
              ),
            ),
          update: (value, tr) => value.map(tr.changes),
          provide: (field) => EditorView.decorations.from(field),
        }),
        ...setup.extensions,
      ],
    });

/** Obsidian's editor, as `obsidianLike`, with a filter that adds to a
 * change of the text, as its live preview renumbers an ordered list or
 * puts a line before a table (`app.js` 1.14.5): `"!"` at the end of the
 * text. Obsidian's leaves a change marked `"set"` alone (the text set
 * from outside); a plugin's may not (`respectsSet: false`). */
export const obsidianAdding =
  (respectsSet: boolean): EditorFactory =>
  (parent, setup) =>
    obsidianLike(parent, {
      ...setup,
      extensions: [
        EditorState.transactionFilter.of((tr) =>
          !tr.docChanged || (respectsSet && tr.isUserEvent("set"))
            ? tr
            : [
                tr,
                {
                  changes: { from: tr.newDoc.length, insert: "!" },
                  sequential: true,
                },
              ],
        ),
        ...setup.extensions,
      ],
    });
