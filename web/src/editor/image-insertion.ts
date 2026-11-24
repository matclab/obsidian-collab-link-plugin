/** Inserting an attached image from the editor (ADR-0057 §8): a file
 * pasted or dropped, or the catalogue's « Image » (the toolbar, the /
 * menu), which asks for one. What then happens — read, stripped,
 * encrypted, uploaded, cited — is the inserter's, loaded on demand; here,
 * only what the editor sees of it. Without an inserter (not an editor,
 * a server without images), a file pasted is the browser's, and the
 * catalogue doesn't offer an image. */
import {
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Where an image goes: a position in the text, followed through every
 * change from the gesture on — another's included (AJ9) —,
 * until released. */
export interface ImageSlot {
  readonly pos: number;
  release(): void;
}

export interface ImageInserter {
  /** Asks for files, and inserts them at `slot`. */
  pick(view: EditorView, slot: ImageSlot): void;
  /** Inserts these files at `slot`. */
  insert(view: EditorView, files: readonly File[], slot: ImageSlot): void;
}

const held = new WeakMap<EditorView, Set<{ pos: number }>>();

/** Holds `at` in `view`'s text, followed through its changes. */
export function holdPosition(view: EditorView, at: number): ImageSlot {
  const slots = held.get(view) ?? new Set();
  held.set(view, slots);
  const slot = { pos: at };
  slots.add(slot);
  return {
    get pos() {
      return slot.pos;
    },
    release: () => void slots.delete(slot),
  };
}

export const imageInserter = Facet.define<
  ImageInserter,
  ImageInserter | undefined
>({ combine: (values) => values[0] });

/** Whether `state`'s editor may insert an image. */
export function mayInsertImage(state: EditorState): boolean {
  return state.facet(imageInserter) !== undefined && !state.readOnly;
}

/** Carried by the catalogue's « Image »: a file to ask for, once the
 * transaction is applied (the / menu's text taken out first). */
export const pickImage = StateEffect.define<null>();

const files = (list: FileList | null | undefined): File[] =>
  Array.from(list ?? []);

/** The editor's side: a pasted or dropped file, and the request. */
export function imageInsertion(): Extension {
  return [
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        for (const slot of held.get(update.view) ?? []) {
          slot.pos = update.changes.mapPos(slot.pos, 1);
        }
      }
      const inserter = update.state.facet(imageInserter);
      if (!inserter) return;
      for (const transaction of update.transactions) {
        if (transaction.effects.some((effect) => effect.is(pickImage))) {
          const at = update.state.selection.main.head;
          inserter.pick(update.view, holdPosition(update.view, at));
        }
      }
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const pasted = files(event.clipboardData?.files);
        if (pasted.length === 0 || !mayInsertImage(view.state)) return false;
        event.preventDefault();
        const at = view.state.selection.main.head;
        view.state
          .facet(imageInserter)
          ?.insert(view, pasted, holdPosition(view, at));
        return true;
      },
      drop(event, view) {
        const dropped = files(event.dataTransfer?.files);
        if (dropped.length === 0 || !mayInsertImage(view.state)) return false;
        event.preventDefault();
        const at =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          view.state.selection.main.head;
        view.state
          .facet(imageInserter)
          ?.insert(view, dropped, holdPosition(view, at));
        return true;
      },
    }),
  ];
}
