// A `[[B]]` written in a linked note's editor, B a linked note
// (docs/phase-19-liens.md, decision 3; LK6). Obsidian closes brackets as
// they are typed and accepts a suggestion in one `input` transaction:
// there is no closing to wait for.
// A link is converted once complete and the caret out of it, and only if
// what the person wrote touched it — never for another's text, an undo or
// a redo. Its own step in the history: Ctrl+Z gives the `[[B]]` back.
import { isolateHistory } from "@codemirror/commands";
import { type Extension, Transaction } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Resolve, toAddresses } from "./wikilinks.js";

interface Range {
  from: number;
  to: number;
}

/** What the person wrote: not another's text, an undo or a redo, nor
 * this conversion's own. */
const written = (tr: Transaction) =>
  tr.docChanged &&
  !tr.annotation(Transaction.remote) &&
  !tr.isUserEvent("input.links") &&
  (tr.isUserEvent("input") || tr.isUserEvent("delete"));

/** `resolveFor` gives, when asked, how this note's `[[…]]` resolve; none
 * while the view has no note or no document. */
export function typedLinks(resolveFor: () => Resolve | undefined): Extension {
  return ViewPlugin.fromClass(
    class {
      /** Where the person wrote, in links not yet left. */
      touched: Range[] = [];
      scheduled = false;
      destroyed = false;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        if (update.docChanged) {
          this.touched = this.touched.map((range) => ({
            from: update.changes.mapPos(range.from, -1),
            to: update.changes.mapPos(range.to, 1),
          }));
          update.transactions.forEach((tr, i) => {
            if (!written(tr)) return;
            // Where it is now: through the transactions after it.
            const later = update.transactions.slice(i + 1);
            tr.changes.iterChangedRanges((_fa, _ta, from, to) => {
              let range = { from, to };
              for (const next of later)
                range = {
                  from: next.changes.mapPos(range.from, -1),
                  to: next.changes.mapPos(range.to, 1),
                };
              this.touched.push(range);
            });
          });
        }
        // Once per microtask, on the state as it is then: the ranges follow
        // each change as it comes, and no import can slip between (it arrives
        // by a network message). Not given up when another transaction came
        // meanwhile (found in the real Obsidian).
        if (this.touched.length > 0 && !this.scheduled) {
          this.scheduled = true;
          queueMicrotask(() => {
            this.scheduled = false;
            this.check();
          });
        }
      }

      destroy(): void {
        this.destroyed = true;
      }

      check(): void {
        // The view closed meanwhile: nothing to write in.
        if (this.destroyed) return;
        const { state } = this.view;
        // A keystroke elsewhere than on a line with `[[` costs nothing.
        this.touched = this.touched.filter((range) => {
          const from = state.doc.lineAt(Math.min(range.from, state.doc.length));
          const to = state.doc.lineAt(Math.min(range.to, state.doc.length));
          return state.sliceDoc(from.from, to.to).includes("[[");
        });
        if (this.touched.length === 0) return;
        const resolve = resolveFor();
        if (!resolve) return;
        const caret = state.selection.main;
        const inside = (link: Range) =>
          (caret.from > link.from && caret.from < link.to) ||
          (caret.to > link.from && caret.to < link.to);
        const meets = (link: Range) =>
          this.touched.some(
            (range) => range.from < link.to && range.to > link.from,
          );
        const text = state.doc.toString();
        const edits = toAddresses(
          text,
          resolve,
          (link) => meets(link) && !inside(link),
        );
        // Kept: what the person still writes in, the caret in a link.
        this.touched = this.touched.filter(
          (range) => caret.from >= range.from - 2 && caret.from <= range.to + 2,
        );
        if (edits.length === 0) return;
        this.view.dispatch({
          changes: edits,
          userEvent: "input.links",
          annotations: isolateHistory.of("full"),
        });
      }
    },
  );
}
