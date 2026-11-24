import {
  BlockType,
  type EditorView,
  RectangleMarker,
  type ViewUpdate,
  layer,
} from "@codemirror/view";
import { type Reveal, liveReveal, revealsBetween } from "./live-reveal.js";

/** A block an editor draws in place of its text: its text's bounds. */
export interface DrawnBlock {
  from: number;
  to: number;
}

/** The blocks of `blocks` that hold a range of `ranges` out of sight (a
 * point from their start to their end, a range any of which is in them),
 * active when the active annotation's is one of them. A remote caret
 * holds nothing: it is not what the frame says. */
export function blocksHolding(
  blocks: readonly DrawnBlock[],
  ranges: readonly Reveal[],
): (DrawnBlock & { active: boolean })[] {
  const held: (DrawnBlock & { active: boolean })[] = [];
  for (const block of blocks) {
    const inside = ranges.filter(
      (range) =>
        range.kind !== "cursor" &&
        (range.from === range.to
          ? block.from <= range.from && range.from <= block.to
          : range.from < block.to && block.from < range.to),
    );
    if (inside.length === 0) continue;
    held.push({
      from: block.from,
      to: block.to,
      active: inside.some((range) => range.kind === "active"),
    });
  }
  return held;
}

/** The blocks the editor draws in place of their text, on screen. */
function drawnOnScreen(view: EditorView): DrawnBlock[] {
  return view.viewportLineBlocks
    .filter((block) => block.type === BlockType.WidgetRange)
    .map(({ from, to }) => ({ from, to }));
}

/** A frame around each block a host's editor draws in place of its text
 * (Obsidian's callouts, tables, formula blocks: choice/obsidian/blocks)
 * that holds an open annotation: its marks and proposed text are on the
 * text, out of sight until the caret goes in. Drawn in a layer of its
 * own, never in the host's block. The annotations' ranges are read only
 * where a block is drawn. */
export const drawnBlocksFrame = layer({
  // Over the block, whose background would hide it.
  above: true,
  class: "cm-drawn-blocks",
  update: (update: ViewUpdate) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.startState.facet(liveReveal) !== update.state.facet(liveReveal),
  markers(view) {
    const blocks = drawnOnScreen(view);
    if (blocks.length === 0) return [];
    const sources = view.state.facet(liveReveal);
    const held = blocks.flatMap((block) =>
      blocksHolding([block], revealsBetween(sources, block.from, block.to)),
    );
    if (held.length === 0) return [];
    // From the scroller's corner, scrolled, as CodeMirror places its own
    // markers; as wide as the text's column.
    const scroller = view.scrollDOM.getBoundingClientRect();
    const content = view.contentDOM.getBoundingClientRect();
    const left =
      content.left - scroller.left + view.scrollDOM.scrollLeft * view.scaleX;
    const top =
      view.documentTop - scroller.top + view.scrollDOM.scrollTop * view.scaleY;
    return held.map((block) => {
      const drawn = view.lineBlockAt(block.from);
      return new RectangleMarker(
        block.active
          ? "cm-drawn-block cm-drawn-block-active"
          : "cm-drawn-block",
        left,
        top + drawn.top,
        content.width,
        drawn.height,
      );
    });
  },
});

/** Chosen on a card or in the review: a passage in a block the editor
 * draws gets the caret, the editor the focus — Obsidian then shows the
 * block's source, and the passage's marks (a callout, a formula block; a
 * table keeps its frame alone: its cells are an editor of their own).
 * True if it was in one. */
export function revealInDrawnBlock(view: EditorView, at: number): boolean {
  if (view.lineBlockAt(at).type !== BlockType.WidgetRange) return false;
  view.focus();
  view.dispatch({ selection: { anchor: at } });
  return true;
}
