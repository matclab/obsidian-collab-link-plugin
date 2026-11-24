// Going to a heading, and which one is read (docs/phase-16-plan-du-document.md,
// decision 6): in the editor when it is shown, else in the preview.
import { EditorView } from "@codemirror/view";
import { headingForFragment } from "../../outline/fragment.js";
import type { OutlineIndex } from "../../outline/outline-index.js";
import type { OutlineHeading } from "../../outline/outline.js";
import { type HeadingTarget, resolveHeading } from "../../outline/resolve.js";

/** Where the text is read. */
export interface ReadingSurfaces {
  view: EditorView;
  /** The rendering: its top-level blocks carry their source lines
   * (`data-line`). */
  previewRoot: HTMLElement;
  /** The editor scrolls in its own column (side by side), not with the
   * view. */
  ownColumn(): boolean;
  /** Where the reading area starts, in the window's pixels: under the
   * view's header, which stays at the top. */
  readingTop(): number;
}

/** Room left above a heading brought to the top. */
const ROOM = 8;
/** How far below the reading area's top a line still counts as read. */
const READ_BELOW = 16;

const editorShown = (surfaces: ReadingSurfaces) => !surfaces.view.dom.hidden;

function previewBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(":scope > [data-line]"));
}

/** Brings `heading` to the top of what is read: the editor's caret on it,
 * the editor focused; or the preview's block that holds its line. */
export function goToHeading(
  surfaces: ReadingSurfaces,
  heading: OutlineHeading,
): void {
  const own = surfaces.ownColumn();
  const margin = (own ? 0 : Math.max(0, surfaces.readingTop())) + ROOM;
  if (editorShown(surfaces)) {
    const { view } = surfaces;
    view.dispatch({
      selection: { anchor: heading.from },
      effects: EditorView.scrollIntoView(heading.from, {
        y: "start",
        yMargin: margin,
      }),
      userEvent: "select",
    });
    view.focus();
    return;
  }
  const { previewRoot } = surfaces;
  let block: HTMLElement | undefined;
  for (const candidate of previewBlocks(previewRoot)) {
    if (Number(candidate.dataset.line) > heading.line) break;
    block = candidate;
  }
  previewRoot.style.setProperty("--reading-top", `${margin}px`);
  block?.scrollIntoView?.({ block: "start" });
}

/** Goes to the heading `target` names in the text now; false when there
 * is none (decision 8). */
export function revealHeading(
  index: OutlineIndex,
  surfaces: ReadingSurfaces,
  target: HeadingTarget,
): boolean {
  const headings = index.current();
  const found = resolveHeading(headings, target);
  if (found === undefined) return false;
  goToHeading(surfaces, headings[found] as OutlineHeading);
  return true;
}

/** Goes to the heading an in-document link, `[t](#id)`, leads to; false when it
 * leads to none. */
export function goToAnchor(
  index: OutlineIndex,
  surfaces: ReadingSurfaces,
  id: string,
): boolean {
  const headings = index.current();
  const found = headingForFragment(headings, id);
  if (found === undefined) return false;
  goToHeading(surfaces, headings[found] as OutlineHeading);
  return true;
}

/** The source line at the top of what is read, from 0. */
export function topLine(surfaces: ReadingSurfaces): number {
  const reading = surfaces.readingTop();
  if (editorShown(surfaces)) {
    const { view } = surfaces;
    const top = Math.max(view.scrollDOM.getBoundingClientRect().top, reading);
    const y = top + READ_BELOW - view.documentTop;
    if (y <= 0) return 0;
    const block = view.lineBlockAtHeight(y);
    return view.state.doc.lineAt(block.from).number - 1;
  }
  const { previewRoot } = surfaces;
  const top =
    Math.max(previewRoot.getBoundingClientRect().top, reading) + READ_BELOW;
  let line = 0;
  for (const block of previewBlocks(previewRoot)) {
    if (block.getBoundingClientRect().top > top) break;
    line = Number(block.dataset.line);
  }
  return line;
}

/** The heading whose section `line` is in: the last one at or above it. */
export function currentHeading(
  headings: readonly OutlineHeading[],
  line: number,
): number | undefined {
  let current: number | undefined;
  for (let i = 0; i < headings.length; i++) {
    if ((headings[i] as OutlineHeading).line > line) break;
    current = i;
  }
  return current;
}
