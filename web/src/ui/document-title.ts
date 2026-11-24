import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { count } from "../perf/index.js";

/** How far into the text the title is looked for: a
 * change past it costs nothing. */
export const TITLE_SCAN = 4096;

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/m;

/** The document's title as the header shows it: its first Markdown
 * heading near the start, or none. Never put in the tab's title: that
 * goes to the browser's history, often synced. */
export function documentTitle(text: string): string | undefined {
  const scanned = text.slice(0, TITLE_SCAN);
  for (let at = 0; ; ) {
    const match = HEADING.exec(scanned.slice(at));
    if (!match) return undefined;
    const title = match[1]?.trim();
    if (title) return title;
    at += (match.index ?? 0) + match[0].length + 1;
  }
}

/** Calls `onTitle` with the title now, then whenever it changes; worked
 * out again only when a change touches the scanned start. */
export function watchTitle(
  view: EditorView,
  onTitle: (title: string | undefined) => void,
): void {
  let shown: string | undefined;
  const compute = () => {
    count("title.compute");
    const title = documentTitle(view.state.sliceDoc(0, TITLE_SCAN));
    if (title !== shown) {
      shown = title;
      onTitle(title);
    }
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        let touched = false;
        update.changes.iterChangedRanges((fromA) => {
          if (fromA < TITLE_SCAN) touched = true;
        });
        if (touched) compute();
      }),
    ),
  });
  count("title.compute");
  shown = documentTitle(view.state.sliceDoc(0, TITLE_SCAN));
  onTitle(shown);
}
