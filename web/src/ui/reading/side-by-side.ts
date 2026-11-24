import { EditorView } from "@codemirror/view";
import { type BlockSpan, previewOffset, sourceLine } from "./scroll-map.js";
import type { Pane } from "./scroll-sync.js";

/** Where this browser keeps its choice of the side-by-side view: a preference,
 * never shared. */
export const SIDE_BY_SIDE_KEY = "obsidian-collab:side-by-side";

/** Whether this device chose the side-by-side view, in `storage` (the
 * page's `localStorage`, the plugin's own). Without storage (private
 * window, blocked site data): not chosen. */
export function storedSideBySide(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(SIDE_BY_SIDE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Keeps the choice, where storage allows; the default is not written. */
export function storeSideBySide(
  on: boolean,
  storage: Storage | undefined,
): void {
  try {
    if (on) storage?.setItem(SIDE_BY_SIDE_KEY, "on");
    else storage?.removeItem(SIDE_BY_SIDE_KEY);
  } catch {
    // Kept for this page only.
  }
}

/** The editor as a column: its source lines from CodeMirror's line blocks,
 * a block replaced by a widget (a table, a formula) counted over its
 * lines. */
export function editorPane(view: EditorView): Pane {
  const scroller = view.scrollDOM;
  // How far down the document the column's top is, in its own pixels.
  const atTop = () => scroller.getBoundingClientRect().top - view.documentTop;
  const lines = (block: { from: number; to: number }) => {
    const first = view.state.doc.lineAt(block.from).number - 1;
    const last = view.state.doc.lineAt(block.to).number - 1;
    return { first, count: last - first + 1 };
  };
  return {
    element: scroller,
    line() {
      const height = atTop();
      const block = view.lineBlockAtHeight(height);
      const { first, count } = lines(block);
      const share = block.height > 0 ? (height - block.top) / block.height : 0;
      return first + Math.min(1, Math.max(0, share)) * count;
    },
    show(line) {
      // CodeMirror places it, in its measure cycle, from the heights it
      // has then measured: computed here, from heights it has only
      // estimated, it landed lines away. A share of a line is a share of
      // its characters: a long paragraph scrolls by its visual lines.
      const { doc } = view.state;
      const at = Math.min(Math.max(0, line), doc.lines - 1e-9);
      const target = doc.line(Math.floor(at) + 1);
      const pos =
        target.from + Math.round((at - Math.floor(at)) * target.length);
      view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
    },
  };
}

/** The rendering as a column: its top-level blocks carry their source
 * lines (`data-line`, `data-line-end`); read at each frame
 * that needs them, never kept (the rendering changes as one types). */
export function previewPane(root: HTMLElement): Pane {
  const blocks = (): BlockSpan[] => {
    const base = root.getBoundingClientRect().top - root.scrollTop;
    return Array.from(
      root.querySelectorAll<HTMLElement>(":scope > [data-line]"),
      (block) => {
        const box = block.getBoundingClientRect();
        return {
          line: Number(block.dataset.line),
          lineEnd: Number(block.dataset.lineEnd),
          top: box.top - base,
          bottom: box.bottom - base,
        };
      },
    );
  };
  return {
    element: root,
    line: () => sourceLine(blocks(), root.scrollTop),
    show(line) {
      root.scrollTop = previewOffset(blocks(), line);
    },
  };
}
