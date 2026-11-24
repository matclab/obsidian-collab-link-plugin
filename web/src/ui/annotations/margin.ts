import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { AnnotationIndex } from "../../../lib/src/index.js";
import { annotationPositions } from "../../editor/annotation-decorations.js";
import { locatedAt } from "../../editor/located-passage.js";
import { t } from "../../i18n/index.js";
import { count } from "../../perf/index.js";
import type { ActiveOrigin } from "../../view-model/active-annotation.js";
import { shownAnchor } from "../reading/preview-marks.js";
import type { ViewSwitch } from "../reading/view-switch.js";
import { NEVER, type ScreenQuery } from "../view-width.js";
import type { AnnotationsPanel } from "./annotations-panel.js";
import { placeCards } from "./margin-layout.js";
import type { Layout } from "./panel-layout.js";

/** Where the margin lives: its view's workspace, told when the margin is
 * hidden, and the element whose keys the review takes — the view's own,
 * not the window's: two views may share it; and the
 * view's widths, not the window's. */
export interface MarginPlace {
  workspace: Element;
  keys: EventTarget;
  narrow?: ScreenQuery;
  wide?: ScreenQuery;
  /** How far down the view's sticky header reaches: what sticks over the
   * text stops under it (ADR-0059 §4). */
  readingTop?: () => number;
}

/** The annotations' layout on the page: on
 * a wide screen, in the margin, each card level with its passage; on a
 * narrow one, side by side with the rendering, or
 * with the margin hidden by its toggle, in a compact sheet that a mark or
 * the toggle opens. The cards are placed at most once per
 * frame (CodeMirror's measure cycle), when the panel renders or the text's
 * geometry changes: never for a keystroke that moves no line. */
export function attachMargin(options: {
  view: EditorView;
  panel: AnnotationsPanel;
  index: AnnotationIndex;
  /** Over the text: where the toggle goes. */
  bar: Element;
  /** Told when the margin is hidden (`margin-hidden`). */
  workspace?: Element;
  /** Where the review's keys are taken: its view's element. */
  keys: EventTarget;
  /** The view is narrow (default: never, unmeasured). */
  narrow?: ScreenQuery;
  /** The modes: in Review, the sheet walks through the annotations. */
  views?: Pick<ViewSwitch, "mode" | "onMode" | "preview" | "sideBySide">;
}): void {
  const { view, panel, index, bar, workspace, views } = options;
  const reviewing = () => views?.mode() === "review";
  const screen = options.narrow ?? NEVER;
  // No room for the margin: the toggle opens the sheet.
  const narrow = {
    matches: () => screen.matches() || (views?.sideBySide() ?? false),
  };
  let marginOn = true;
  let layout: Layout | undefined;
  // Each card's height when last placed.
  let placedHeights = new Map<Element | undefined, number>();

  const toggle = document.createElement("button");
  toggle.className = "margin-toggle quiet";
  bar.append(toggle);
  toggle.addEventListener("click", () => {
    if (narrow.matches()) {
      panel.openSheet();
      return;
    }
    marginOn = !marginOn;
    apply();
  });

  const openCount = () =>
    index.current().annotations.filter((a) => a.status === "open").length;
  const label = () => {
    const wide = !narrow.matches();
    toggle.textContent = wide
      ? t().annotationsInMargin
      : t().annotationsCount(openCount());
    if (wide) toggle.setAttribute("aria-pressed", String(marginOn));
    else toggle.removeAttribute("aria-pressed");
  };

  const apply = () => {
    const next: Layout =
      !reviewing() && !narrow.matches() && marginOn ? "margin" : "sheet";
    workspace?.classList.toggle("margin-hidden", next === "sheet");
    // The history takes the whole width, without the annotations.
    workspace?.classList.toggle("history-mode", views?.mode() === "history");
    toggle.hidden = reviewing() || views?.mode() === "history";
    label();
    if (next !== layout) {
      layout = next;
      panel.setLayout(next);
      if (next !== "margin") clear();
    }
    panel.setReview(reviewing());
    if (reviewing()) {
      // On the first card to go through, unless one is already chosen.
      const shown = panel.shownId();
      if (shown) panel.active.set(shown, "review");
    }
  };

  const clear = () => {
    const list = panel.openList();
    if (!list) return;
    list.style.height = "";
    for (const card of Array.from(list.children) as HTMLElement[]) {
      card.style.top = "";
    }
  };

  const NOWHERE = Number.MAX_SAFE_INTEGER / 2; // no passage: last
  // Where a passage stands: in the editor, from its marks' positions; in
  // the preview, from its marks there, else its block. Ids
  // come from any reviewer: compared, never put in a selector.
  const anchors = (): ((id: string) => number) => {
    const preview = views?.preview;
    if (preview?.visible) {
      const tops = new Map<string, number>();
      for (const marked of Array.from(
        preview.root.querySelectorAll<HTMLElement>(
          "[data-ann], [data-ann-block]",
        ),
      )) {
        const top = shownAnchor(marked).getBoundingClientRect().top;
        const ids = marked.dataset.ann
          ? [marked.dataset.ann]
          : (marked.dataset.annBlock ?? "").split(" ");
        for (const id of ids) if (id && !tops.has(id)) tops.set(id, top);
      }
      // A closed card whose text is shown: by its line's block.
      const located = locatedAt(view.state);
      const block = located && locatedBlock(preview.root, located.from);
      if (located && block) {
        tops.set(located.id, block.getBoundingClientRect().top);
      }
      return (id) => tops.get(id) ?? NOWHERE;
    }
    const positions = annotationPositions(view);
    // A closed card whose text is shown: by its marked place.
    const located = locatedAt(view.state);
    if (located) positions.set(located.id, located.from);
    const end = view.state.doc.length;
    return (id) => {
      const at = positions.get(id);
      return at === undefined
        ? NOWHERE
        : view.lineBlockAt(Math.min(at, end)).top + view.documentTop;
    };
  };
  const read = () => {
    const list = panel.openList();
    if (!list) return undefined;
    count("margin.layout");
    const at = anchors();
    const base = list.getBoundingClientRect().top;
    const cards = Array.from(list.children) as HTMLElement[];
    const items = cards.map((card) => ({
      id: card.dataset.id ?? "",
      want: at(card.dataset.id ?? "") - base,
      height: card.offsetHeight,
    }));
    placedHeights = new Map(items.map((item, i) => [cards[i], item.height]));
    return { list, cards, tops: placeCards(items, panel.active.id) };
  };
  const write = (measured: ReturnType<typeof read>) => {
    if (!measured) return;
    let bottom = 0;
    for (const card of measured.cards) {
      const top = measured.tops.get(card.dataset.id ?? "") ?? 0;
      card.style.top = `${top}px`;
      bottom = Math.max(bottom, top + card.offsetHeight);
    }
    measured.list.style.height = `${bottom}px`;
  };
  // The editor hidden, CodeMirror may not measure: the preview's own frame.
  let framed = false;
  const place = () => {
    if (layout !== "margin") return;
    if (!views?.preview.visible) {
      view.requestMeasure({ key: "oc-margin", read, write });
      return;
    }
    if (framed) return;
    framed = true;
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (run: () => void) => setTimeout(run, 0);
    frame(() => {
      framed = false;
      if (layout === "margin") write(read());
    });
  };

  // A card grown or shrunk in place (a reply's field resized by hand, an
  // image loaded): the cards around it move. Only for a height other than
  // the one it was placed with: observing a card reports its size once.
  // Its window's `ResizeObserver` (Obsidian may open the view in another
  // window); without one (jsdom), placed at each render only.
  const Observer = view.dom.ownerDocument.defaultView?.ResizeObserver;
  const resized =
    typeof Observer === "function"
      ? new Observer((entries) => {
          const moved = entries.some(
            ({ target }) =>
              (target as HTMLElement).offsetHeight !==
              placedHeights.get(target),
          );
          if (moved) place();
        })
      : undefined;
  const observed = new Set<Element>();
  const observeCards = () => {
    if (!resized) return;
    const cards = new Set(
      layout === "margin" ? Array.from(panel.openList()?.children ?? []) : [],
    );
    for (const card of observed) {
      if (!cards.has(card)) {
        resized.unobserve(card);
        observed.delete(card);
      }
    }
    for (const card of cards) {
      if (!observed.has(card)) {
        resized.observe(card);
        observed.add(card);
      }
    }
  };

  panel.onRendered(() => {
    label();
    observeCards();
    place();
  });
  // Its text shown with the preview alone: its line's block brought into
  // view, as the editor brings its passage.
  panel.onLocated((at) => {
    if (!views?.preview.visible || views.sideBySide()) return;
    locatedBlock(views.preview.root, at)?.scrollIntoView?.({
      block: "center",
    });
  });
  /** The preview's block that holds the line of `at`: the last one that
   * starts at or above it. */
  function locatedBlock(root: HTMLElement, at: number) {
    const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
    let block: HTMLElement | undefined;
    for (const candidate of Array.from(
      root.querySelectorAll<HTMLElement>(":scope > [data-line]"),
    )) {
      if (Number(candidate.dataset.line) > line.number - 1) break;
      block = candidate;
    }
    return block;
  }
  // A mark opens the sheet, the active one's too, the sheet closed since.
  const markOpensSheet = (_: unknown, origin: ActiveOrigin) => {
    if (layout === "sheet" && origin === "mark") panel.openSheet();
  };
  panel.active.subscribe(markOpensSheet);
  panel.active.subscribeAgain(markOpensSheet);
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        // Lines moved only if some height changed: a keystroke within a
        // line moves nothing (geometryChanged is true for any edit).
        if (update.heightChanged) place();
      }),
    ),
  });
  screen.onChange(apply);
  views?.onMode(() => {
    apply();
    place();
  });
  views?.preview.onRendered(place);
  // A callout folded or unfolded moves the passages below it; `toggle`
  // does not bubble.
  views?.preview.root.addEventListener("toggle", place, true);
  // In Review: arrows go from one card to the next, a accepts (or
  // resolves a comment), r rejects — never while typing in a field or the
  // text.
  options.keys.addEventListener("keydown", (raw) => {
    const event = raw as KeyboardEvent;
    if (!reviewing() || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest("input, textarea, select") ||
      target?.isContentEditable
    ) {
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowRight: () => panel.step(1),
      ArrowLeft: () => panel.step(-1),
      a: () => panel.act("accept"),
      r: () => panel.act("reject"),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  });
  apply();
  place();
}
