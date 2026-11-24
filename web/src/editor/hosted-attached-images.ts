/** Attached images in a host's editor (ADR-0057 §9: Obsidian's, in the
 * view): its syntax tree isn't ours, so found by their text — on one
 * line, its source shown while a caret is on it, as Obsidian shows a
 * construction's —, and drawn by the page's widget, before the host's own
 * image (which would ask its address of the vault). */
import { type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { attachmentOf } from "../render/index.js";
import { AttachedImageWidget, attachedImagesFacet } from "./live-widgets.js";

const IMAGE = /!\[([^\]\n]*)\]\((attachment:[^)\s]*)\)/g;

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const images = view.state.facet(attachedImagesFacet);
  const { state } = view;
  const carets = new Set(
    view.hasFocus
      ? state.selection.ranges.flatMap((range) => [
          state.doc.lineAt(range.from).number,
          state.doc.lineAt(range.to).number,
        ])
      : [],
  );
  for (const { from, to } of view.visibleRanges) {
    let line = state.doc.lineAt(from);
    for (;;) {
      if (!carets.has(line.number)) {
        for (const found of line.text.matchAll(IMAGE)) {
          const id = attachmentOf(found[2] ?? "");
          if (id === null) continue;
          const start = line.from + (found.index ?? 0);
          builder.add(
            start,
            start + found[0].length,
            Decoration.replace({
              widget: new AttachedImageWidget(id, found[1] ?? "", images),
            }),
          );
        }
      }
      if (line.to >= to || line.number >= state.doc.lines) break;
      line = state.doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

export function hostedAttachedImages(): Extension {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorate(view);
        }
        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged ||
            update.focusChanged
          ) {
            this.decorations = decorate(update.view);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
  );
}
