/** Whether a width holds, and when that changes. */
export interface ScreenQuery {
  matches(): boolean;
  onChange(listener: () => void): void;
}

/** Never: a view nobody measures (tests, the trace replay). */
export const NEVER: ScreenQuery = {
  matches: () => false,
  onChange: () => {},
};

/** The view's widths: narrow (≤ 56.25 rem, 900 px at the browser's
 * default: the annotations in a sheet) and wide (≥ 75 rem, 1200 px: room
 * for side by side), as `page.css` asks them with `@container
 * document-view`. In rem, to follow the text size the reader chose
 * (AGENTS.md, §3); read at each resize: a text size changed alone is
 * taken at the next one, where the CSS takes it at once. */
export interface ViewWidths {
  narrow: ScreenQuery;
  wide: ScreenQuery;
  /** Stops observing (the view closes). */
  close(): void;
}

const NARROW_MAX_REM = 56.25;
const WIDE_MIN_REM = 75;

/** One rem, in px: the root's font size (16 px without one). */
function remOf(element: Element): number {
  const root = element.ownerDocument.documentElement;
  const view = element.ownerDocument.defaultView;
  const size = Number.parseFloat(view?.getComputedStyle(root).fontSize ?? "");
  return size > 0 ? size : 16;
}

/** The widths of the view's element, not of the window: a narrow pane of
 * Obsidian is narrow. Its window's
 * `ResizeObserver` (Obsidian may open the view in another window);
 * without one (jsdom), neither narrow nor wide. */
export function viewWidths(element: Element): ViewWidths {
  const Observer = element.ownerDocument.defaultView?.ResizeObserver;
  if (typeof Observer !== "function") {
    return { narrow: NEVER, wide: NEVER, close: () => {} };
  }
  let width: number | undefined;
  let rem = 16;
  const narrowListeners: (() => void)[] = [];
  const wideListeners: (() => void)[] = [];
  const isNarrow = () => width !== undefined && width <= NARROW_MAX_REM * rem;
  const isWide = () => width !== undefined && width >= WIDE_MIN_REM * rem;
  const observer = new Observer((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const [wasNarrow, wasWide] = [isNarrow(), isWide()];
    width = entry.contentRect.width;
    rem = remOf(element);
    if (isNarrow() !== wasNarrow) for (const l of narrowListeners) l();
    if (isWide() !== wasWide) for (const l of wideListeners) l();
  });
  observer.observe(element);
  return {
    narrow: { matches: isNarrow, onChange: (l) => narrowListeners.push(l) },
    wide: { matches: isWide, onChange: (l) => wideListeners.push(l) },
    close: () => observer.disconnect(),
  };
}
