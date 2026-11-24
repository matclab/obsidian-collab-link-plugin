import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { OutlineIndex } from "./outline-index.js";

/** Tells `index` each change of the editor's text, as it happens: only
 * recorded there (decision 4), nothing parsed. */
export function followEditor(view: EditorView, index: OutlineIndex): void {
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) index.update(update.changes, update.state.doc);
      }),
    ),
  });
}
