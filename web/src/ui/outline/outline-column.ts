// The outline's column (docs/phase-16-plan-du-document.md, decisions 1 to
// 3, 6): left of the text, in Write, closable; a drawer over the text in
// a narrow view. Its width set by a handle at its edge (ADR-0062, PV1 to
// PV3).
import { flushSync, mount, unmount } from "svelte";
import { t } from "../../i18n/index.js";
import type { OutlineIndex } from "../../outline/outline-index.js";
import { keysOf } from "../../outline/outline-tree.js";
import { targetOf } from "../../outline/resolve.js";
import { count } from "../../perf/index.js";
import type { ViewSwitch } from "../reading/view-switch.js";
import { NEVER, type ScreenQuery } from "../view-width.js";
import Outline from "./Outline.svelte";
import OutlineToggle from "./OutlineToggle.svelte";
import {
  type ReadingSurfaces,
  currentHeading,
  revealHeading,
  topLine as surfacesTopLine,
} from "./outline-navigation.js";
import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  OUTLINE_WIDTH_KEY,
  keyedWidth,
  storedWidth,
  widthFromPixels,
} from "./outline-width.js";

/** Where this device keeps the column open or closed (decision 3): a
 * preference, never shared. */
export const OUTLINE_KEY = "obsidian-collab:outline";

/** Open or closed as this device chose, or not chosen. */
export function storedOutline(
  storage: Storage | undefined,
): boolean | undefined {
  try {
    const kept = storage?.getItem(OUTLINE_KEY);
    return kept === "open" ? true : kept === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}

function storeOutline(open: boolean, storage: Storage | undefined): void {
  try {
    storage?.setItem(OUTLINE_KEY, open ? "open" : "closed");
  } catch {
    // Kept for this page only.
  }
}

function storeWidth(width: number, storage: Storage | undefined): void {
  try {
    if (width === DEFAULT_OUTLINE_WIDTH) storage?.removeItem(OUTLINE_WIDTH_KEY);
    else storage?.setItem(OUTLINE_WIDTH_KEY, String(width));
  } catch {
    // Kept for this page only.
  }
}

function keptWidth(storage: Storage | undefined): number {
  try {
    return (
      storedWidth(storage?.getItem(OUTLINE_WIDTH_KEY)) ?? DEFAULT_OUTLINE_WIDTH
    );
  } catch {
    return DEFAULT_OUTLINE_WIDTH;
  }
}

/** The handle at the column's edge (PV1): a separator, moved by the
 * pointer or the keyboard; the width set on the workspace, kept once
 * chosen (PV2). Beside the list, never in the drawer (PV3). */
function mountHandle(
  aside: HTMLElement,
  workspace: HTMLElement,
  preferences: Storage | undefined,
): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "outline-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-controls", aside.id);
  handle.setAttribute("aria-valuemin", String(MIN_OUTLINE_WIDTH));
  handle.setAttribute("aria-valuemax", String(MAX_OUTLINE_WIDTH));
  handle.setAttribute("aria-label", t().outlineWidth);
  handle.title = t().outlineWidthHint;
  handle.tabIndex = 0;
  let width = keptWidth(preferences);
  const show = () => {
    handle.setAttribute("aria-valuenow", String(width));
    if (width === DEFAULT_OUTLINE_WIDTH)
      workspace.style.removeProperty("--outline-width");
    else workspace.style.setProperty("--outline-width", `${width}rem`);
  };
  const choose = (next: number) => {
    width = next;
    show();
    storeWidth(width, preferences);
  };
  const remPixels = () =>
    Number.parseFloat(
      getComputedStyle(aside.ownerDocument.documentElement).fontSize,
    ) || 16;
  let dragging: number | undefined;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = (event as PointerEvent).pointerId ?? 0;
    // jsdom has no pointer capture.
    if (typeof handle.setPointerCapture === "function" && "pointerId" in event)
      handle.setPointerCapture(dragging);
  });
  handle.addEventListener("pointermove", (event) => {
    if (dragging === undefined) return;
    width = widthFromPixels(
      event.clientX - aside.getBoundingClientRect().left,
      remPixels(),
    );
    show();
  });
  const release = () => {
    if (dragging === undefined) return;
    dragging = undefined;
    storeWidth(width, preferences);
  };
  handle.addEventListener("pointerup", release);
  handle.addEventListener("pointercancel", release);
  handle.addEventListener("dblclick", () => choose(DEFAULT_OUTLINE_WIDTH));
  handle.addEventListener("keydown", (event) => {
    const next = keyedWidth(width, event.key);
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  });
  show();
  aside.append(handle);
  return handle;
}

export interface OutlineColumn {
  /** The document's text is there: whether it opens by default is
   * decided from it (mounted with the editor, before the text came). */
  opened(): void;
  destroy(): void;
}

let columns = 0;

/** Mounts the outline in `aside`, its toggle in the tools over the text.
 *
 * - Open on a wide view by default when there are headings; the user's
 *   choice is kept. In a narrow view, a drawer, closed at first, closed
 *   again by a choice or Escape; opening it keeps nothing.
 * - Only in Write; listens to the outline only while it is shown: closed,
 *   typing parses nothing (decision 4).
 * - The heading read is marked at most once per frame, after a scroll of
 *   the text (not of the outline), a change of the list or of what is
 *   shown; brought into view by the outline's scroll alone. */
export function createOutlineColumn(
  aside: HTMLElement,
  options: {
    index: OutlineIndex;
    surfaces: ReadingSurfaces;
    views: Pick<ViewSwitch, "mode" | "onMode" | "bar">;
    /** Told whether the column takes its place (`with-outline`). */
    workspace: HTMLElement;
    narrow?: ScreenQuery;
    wide?: ScreenQuery;
    preferences?: Storage | undefined;
    frame?: (run: () => void) => void;
    /** Where scrolls are heard (default: the view's document). */
    events?: EventTarget;
    /** The source line read (default: from the surfaces' boxes). */
    topLine?: () => number;
  },
): OutlineColumn {
  const { index, surfaces, views, workspace, preferences } = options;
  const narrow = options.narrow ?? NEVER;
  const wide = options.wide ?? NEVER;
  const frame =
    options.frame ?? ((run: () => void) => requestAnimationFrame(run));
  const events = options.events ?? aside.ownerDocument;
  const topLine = options.topLine ?? (() => surfacesTopLine(surfaces));

  aside.id ||= `outline-column-${++columns}`;
  aside.classList.add("view-outline");
  // The list, in the column or in the drawer: a modal dialog, in the
  // browser's top layer — the view's containment would hold a fixed
  // element to the view, not to the window.
  const holder = document.createElement("div");
  holder.className = "outline-holder";
  aside.append(holder);
  mountHandle(aside, workspace, preferences);
  const drawer = document.createElement("dialog");
  drawer.className = "outline-drawer";
  drawer.id = `${aside.id}-drawer`;
  workspace.append(drawer);
  let chosen = storedOutline(preferences);
  let drawerOpen = false;
  let hadHeadings = index.current().length > 0;
  /** The list shown, whose ranks the items carry. */
  let shownList = index.current();
  let unsubscribe: (() => void) | undefined;
  let pending = false;

  const writing = () => views.mode() === "write";
  const isOpen = () =>
    narrow.matches() ? drawerOpen : (chosen ?? (wide.matches() && hadHeadings));
  const shown = () => writing() && isOpen();

  const outline = mount(Outline, {
    target: holder,
    props: {
      onGo: (rank: number) => go(rank),
      onClose: () => toggle(),
      onEscape: () => {
        if (narrow.matches() && drawerOpen) toggle();
      },
    },
  });
  const toggler = mount(OutlineToggle, {
    target: views.bar,
    anchor: views.bar.firstChild ?? undefined,
    props: { onToggle: () => toggle() },
  });
  /** Opens or closes the drawer, the list moved into it or back. */
  const showDrawer = (open: boolean) => {
    if (open) {
      if (holder.parentElement !== drawer) drawer.append(holder);
      if (drawer.open) return;
      // Every browser the page targets has it; jsdom, under the tests,
      // doesn't: the dialog is then merely open (as `dialog.ts`).
      if (typeof drawer.showModal === "function") drawer.showModal();
      else drawer.setAttribute("open", "");
      return;
    }
    if (drawer.open) {
      if (typeof drawer.close === "function") drawer.close();
      else drawer.removeAttribute("open");
    }
    if (holder.parentElement !== aside) aside.append(holder);
  };
  // Closed by the browser: its Escape, or a click outside.
  drawer.addEventListener("close", () => {
    if (!drawerOpen) return;
    drawerOpen = false;
    apply();
    toggler.focus();
  });
  drawer.addEventListener("click", (event) => {
    if (event.target === drawer && drawerOpen) toggle();
  });

  const markCurrent = () => {
    pending = false;
    if (!shown()) return;
    // Under the view's header, however tall it is now.
    aside.style.setProperty("--outline-top", `${surfaces.readingTop()}px`);
    outline.setCurrent(currentHeading(shownList, topLine()));
    flushSync();
    outline.showCurrent(drawer.open ? drawer : holder);
  };
  const scheduleCurrent = () => {
    if (pending) return;
    pending = true;
    frame(markCurrent);
  };
  const render = () => {
    count("outline.render");
    shownList = index.current();
    const keys = keysOf(shownList);
    outline.setItems(
      shownList.flatMap((heading, rank) =>
        heading.text
          ? [
              {
                index: rank,
                level: heading.level,
                text: heading.text,
                key: keys[rank] as string,
              },
            ]
          : [],
      ),
    );
    flushSync();
    scheduleCurrent();
  };
  const apply = () => {
    const visible = shown();
    const asDrawer = narrow.matches();
    showDrawer(visible && asDrawer);
    aside.hidden = !visible || asDrawer;
    workspace.classList.toggle("with-outline", visible && !asDrawer);
    // Open as a column, it is closed from its own head (decision 1).
    toggler.set({
      open: visible,
      shown: writing() && !(visible && !asDrawer),
      controls: asDrawer ? drawer.id : aside.id,
    });
    if (visible && !unsubscribe) {
      unsubscribe = index.subscribe(render);
      render();
    } else if (!visible && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    if (visible) scheduleCurrent();
    flushSync();
  };
  const toggle = () => {
    if (narrow.matches()) {
      drawerOpen = !drawerOpen;
      apply();
      if (drawerOpen) outline.focusFirst();
      else toggler.focus();
      return;
    }
    chosen = !isOpen();
    storeOutline(chosen, preferences);
    apply();
  };
  /** A heading chosen: named from the list shown, found in the text now
   * (decision 8: the text may have changed since the list was shown). */
  const go = (rank: number) => {
    revealHeading(index, surfaces, targetOf(shownList, rank));
    if (narrow.matches() && drawerOpen) {
      drawerOpen = false;
      apply();
    }
    scheduleCurrent();
  };
  // The outline's own scroll is not the text read: marking would bring
  // the heading back under the wheel.
  const scrolled = (event: Event) => {
    const from = event.target;
    if (from instanceof Node && (aside.contains(from) || drawer.contains(from)))
      return;
    if (shown()) scheduleCurrent();
  };
  events.addEventListener("scroll", scrolled, { capture: true, passive: true });
  views.onMode(() => apply());
  narrow.onChange(() => {
    drawerOpen = false;
    apply();
  });
  wide.onChange(() => apply());
  apply();
  return {
    opened() {
      hadHeadings = index.current().length > 0;
      apply();
    },
    destroy() {
      unsubscribe?.();
      events.removeEventListener("scroll", scrolled, { capture: true });
      void unmount(outline);
      void unmount(toggler);
      drawer.remove();
    },
  };
}
