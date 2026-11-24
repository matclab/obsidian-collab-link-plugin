import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RemoteImages } from "../view-model/remote-images.js";

/** The reader's grants, in the editor's state (ADR-0055 §6): a new value
 * at each change, so the formatted text is drawn again. */
interface Grants {
  images: RemoteImages | undefined;
}

const changed = StateEffect.define<RemoteImages>();

const grants = StateField.define<Grants>({
  create: () => ({ images: undefined }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(changed)) return { images: effect.value };
    }
    return value;
  },
});

/** The grants of `state`'s editor, if it has any: none, no remote image. */
export function remoteImageGrants(state: EditorState): Grants | undefined {
  return state.field(grants, false);
}

/** Draws in `view` the remote images `images` grants, again at each
 * change. Returns a stop. */
export function attachRemoteImages(
  view: EditorView,
  images: RemoteImages,
): () => void {
  view.dispatch({
    effects: [StateEffect.appendConfig.of(grants), changed.of(images)],
  });
  return images.subscribe(() => view.dispatch({ effects: changed.of(images) }));
}
