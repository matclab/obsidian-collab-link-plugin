import type { EditorView } from "@codemirror/view";
import { afterAll, afterEach, beforeAll } from "vitest";

/** What jsdom lacks once CodeMirror is asked to scroll a position into
 * view: the boxes of the text, empty here. For a test file whose commands
 * scroll (`scrollIntoView: true`). CodeMirror measures in a later frame:
 * each view given to the function returned is destroyed after its test,
 * before the boxes go. */
export function withoutLayout(): (view: EditorView) => void {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
  });
  const saved = {
    rects: Range.prototype.getClientRects,
    box: Range.prototype.getBoundingClientRect,
  };
  beforeAll(() => {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  });
  afterAll(() => {
    Range.prototype.getClientRects = saved.rects;
    Range.prototype.getBoundingClientRect = saved.box;
  });
  return (view) => views.push(view);
}
