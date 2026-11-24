import { type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { AnnotationIndex, AnnotationsView } from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import { count, span } from "../perf/index.js";
import type { ActiveAnnotation } from "../view-model/active-annotation.js";
import { liveReveal, revealSource } from "./live-reveal.js";

const ACTIVE = "cm-annotation-active";

/** A press and its release on an annotation's widget reach the editor's
 * handlers, as on a mark: CodeMirror ignores, by default, every event in
 * a widget — its click then opened nothing. */
function pressOrRelease(event: Event): boolean {
  return event.type === "mousedown" || event.type === "mouseup";
}

const MARK_CLASS_BY_TYPE: Record<
  "addition" | "deletion" | "substitution",
  string
> = {
  addition: "cm-annotation-addition",
  deletion: "cm-annotation-deletion",
  substitution: "cm-annotation-substitution",
};

/** Where a comment's passage was, once its text is gone. */
class CommentWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly id: string,
    readonly active: boolean,
  ) {
    super();
  }
  override eq(other: CommentWidget): boolean {
    return (
      other.body === this.body &&
      other.id === this.id &&
      other.active === this.active
    );
  }
  override ignoreEvent(event: Event): boolean {
    return !pressOrRelease(event);
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-annotation-comment${this.active ? ` ${ACTIVE}` : ""}`;
    span.title = this.body;
    span.dataset.ann = this.id;
    span.textContent = "💬";
    return span;
  }
}

/** A pending suggestion's proposed text (ADR-0018: not in `content`), or
 * a sign that it can't be shown: its change still waits for what it
 * depends on, or is invalid. A text with a line break, at a line's edge,
 * is a block between the lines: in the line, it would take
 * that line's form, a heading's. */
class ProposalWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
    readonly title: string,
    readonly id: string,
    readonly inserted = false,
    readonly block = false,
  ) {
    super();
  }
  override eq(other: ProposalWidget): boolean {
    return (
      other.block === this.block &&
      other.inserted === this.inserted &&
      other.text === this.text &&
      other.className === this.className &&
      other.title === this.title &&
      other.id === this.id
    );
  }
  override ignoreEvent(event: Event): boolean {
    return !pressOrRelease(event);
  }
  override toDOM(): HTMLElement {
    // A proposed text is an insertion, for a screen reader; a
    // sign that it can't be shown is not.
    const span = document.createElement(this.inserted ? "ins" : "span");
    span.className = this.className;
    // Its line breaks at its ends are the block's edges.
    span.textContent = this.block
      ? this.text.replace(/^\n+|\n+$/g, "")
      : this.text;
    span.dataset.ann = this.id;
    if (this.title) span.title = this.title;
    if (!this.block) return span;
    const block = document.createElement("div");
    block.className = "cm-annotation-block";
    block.append(span);
    return block;
  }
}

/** Where `at` is in its line: at its start, its end (both on a blank
 * line), or neither. */
export type LineEdge = (at: number) => "start" | "end" | undefined;

function proposalWidget(
  view: AnnotationsView,
  annotation: AnnotationsView["annotations"][number],
  range: { start: number; end: number },
  active: boolean,
  edge: LineEdge,
): Range<Decoration> | undefined {
  const preview = view.previews.get(annotation.id);
  if (!preview || preview.kind === "present") return undefined;
  const on = active ? ` ${ACTIVE}` : "";
  const { id } = annotation;
  const side =
    preview.kind === "valid" && preview.text.includes("\n")
      ? edge(preview.at)
      : undefined;
  const widget =
    preview.kind === "valid"
      ? new ProposalWidget(
          preview.text,
          `${annotation.type === "addition" ? MARK_CLASS_BY_TYPE.addition : "cm-annotation-replacement"}${on}`,
          "",
          id,
          true,
          side !== undefined,
        )
      : preview.kind === "pending"
        ? new ProposalWidget(
            "…",
            `cm-annotation-pending${on}`,
            t().waitingForText,
            id,
          )
        : new ProposalWidget(
            "⚠",
            `cm-annotation-invalid${on}`,
            preview.reason,
            id,
          );
  const at = preview.kind === "valid" ? preview.at : range.end;
  if (side !== undefined) {
    // Above the line it starts, below the line it ends.
    return Decoration.widget({
      widget,
      block: true,
      side: side === "start" ? -1 : 1,
    }).range(at);
  }
  return Decoration.widget({ widget, side: 1 }).range(at);
}

/** `LineEdge` over a text. */
function edgeIn(text: string): LineEdge {
  return (at) =>
    at === 0 || text[at - 1] === "\n"
      ? "start"
      : at === text.length || text[at] === "\n"
        ? "end"
        : undefined;
}

function buildDecorations(
  view: AnnotationsView,
  activeId: string | undefined,
  edge: LineEdge,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const annotation of view.annotations) {
    const range = annotation.range;
    if (!range) continue;
    // Decided or resolved: a suggestion's effect is applied, a comment is
    // closed — either way, nothing left to show.
    if (annotation.status !== "open") continue;
    const active = annotation.id === activeId;
    const on = active ? ` ${ACTIVE}` : "";
    const attributes = { "data-ann": annotation.id };
    if (annotation.type === "comment") {
      // Its passage highlighted; a marker once it is gone.
      ranges.push(
        range.start < range.end
          ? Decoration.mark({
              class: `cm-annotation-comment${on}`,
              attributes: { ...attributes, title: annotation.body ?? "" },
            }).range(range.start, range.end)
          : Decoration.widget({
              widget: new CommentWidget(
                annotation.body ?? "",
                annotation.id,
                active,
              ),
              side: 1,
            }).range(range.end),
      );
      continue;
    }
    if (range.start < range.end) {
      ranges.push(
        Decoration.mark({
          // What it takes out is a deletion, for a screen reader.
          ...(annotation.type !== "addition" && { tagName: "del" }),
          class: `${MARK_CLASS_BY_TYPE[annotation.type]}${on}`,
          attributes,
        }).range(range.start, range.end),
      );
    }
    const proposal = proposalWidget(view, annotation, range, active, edge);
    if (proposal) ranges.push(proposal);
  }
  // Let CodeMirror sort: a comment widget sits at its range *end*, so no
  // single key over annotations orders every decoration position.
  return Decoration.set(ranges, true);
}

const setAnnotationDecorations = StateEffect.define<DecorationSet>();

const annotationDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAnnotationDecorations)) return effect.value;
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Whether an annotation decoration belongs to the active annotation. */
function isActive(decoration: Decoration): boolean {
  const { spec } = decoration;
  return spec.widget instanceof CommentWidget
    ? spec.widget.active
    : spec.widget instanceof ProposalWidget
      ? spec.widget.className.includes(ACTIVE)
      : String(spec.class).includes(ACTIVE);
}

function describe(decorations: DecorationSet): string[] {
  const described: string[] = [];
  for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
    const { spec } = cursor.value;
    // Which annotation is active is the page's, not the docs'.
    const what = (
      spec.widget instanceof CommentWidget
        ? `comment ${spec.widget.body}`
        : spec.widget instanceof ProposalWidget
          ? `${spec.widget.className}${spec.widget.block ? " block" : ""} ${spec.widget.text}`
          : spec.class === "cm-annotation-comment" ||
              String(spec.class).startsWith("cm-annotation-comment ")
            ? `comment ${spec.attributes?.title ?? ""}`
            : String(spec.class)
    ).replace(` ${ACTIVE}`, "");
    described.push(`${cursor.from}-${cursor.to} ${what}`);
  }
  return described;
}

/** Where each open annotation's passage starts in `view` now: the
 * decorations' positions, which CodeMirror maps through every edit —
 * unlike the index, which is not resolved again per keystroke. */
export function annotationPositions(view: EditorView): Map<string, number> {
  const positions = new Map<string, number>();
  const field = view.state.field(annotationDecorationsField, false);
  for (let cursor = field?.iter(); cursor?.value; cursor.next()) {
    const { spec } = cursor.value;
    const id =
      spec.widget instanceof CommentWidget ||
      spec.widget instanceof ProposalWidget
        ? spec.widget.id
        : (spec.attributes?.["data-ann"] as string | undefined);
    if (id !== undefined && !positions.has(id)) positions.set(id, cursor.from);
  }
  return positions;
}

/** The annotation decorations `view` currently holds, described — to
 * compare with `describeFreshDecorations` (the multi-peer simulation). */
export function describeShownDecorations(view: EditorView): string[] {
  return describe(
    view.state.field(annotationDecorationsField, false) ?? Decoration.none,
  );
}

/** What a rebuild from the index would hold, described. */
export function describeFreshDecorations(index: AnnotationIndex): string[] {
  return describe(
    buildDecorations(
      index.current(),
      undefined,
      edgeIn(index.contentDoc.getText("content").toString()),
    ),
  );
}

/** How far, in pixels, the pointer may move between press and release
 * for a click on a mark. */
const CLICK_SLOP = 4;

/** Wires annotation decorations (strikethrough for a deletion or a
 * substitution's old text, a widget for a pending suggestion's proposed
 * text, a highlight for a comment's passage) into `view`, from the shared
 * index (`annotations/`) — never `transport` nor the network directly
 * (AGENTS.md §3). The active annotation stands out, and a
 * click on a mark makes its annotation active, at once even where the
 * press reveals the line's markup. Rebuilt when the index
 * notifies, and only if its view changed (a confirmed decision alone
 * changes nothing here until its effect is written), or when the active
 * annotation changes. A local keystroke doesn't notify: CodeMirror's own
 * mapping shifts the marks, and resolving every annotation on every
 * character typed would be wasted work (phase-4 §3). Returns an
 * unsubscribe function. */
export function attachAnnotationDecorations(
  view: EditorView,
  index: AnnotationIndex,
  active?: ActiveAnnotation,
): () => void {
  let shown: { view: AnnotationsView; active: string | undefined } | undefined;
  let pressed: { id: string; x: number; y: number } | undefined;
  function recompute(): void {
    const current = index.current();
    const activeId = active?.id;
    if (current === shown?.view && activeId === shown.active) return;
    shown = { view: current, active: activeId };
    count("decorations.build");
    span("decorations", () =>
      view.dispatch({
        effects: setAnnotationDecorations.of(
          buildDecorations(current, activeId, (at) => {
            const { doc } = view.state;
            if (at > doc.length) return undefined;
            const line = doc.lineAt(at);
            return at === line.from
              ? "start"
              : at === line.to
                ? "end"
                : undefined;
          }),
        ),
      }),
    );
  }

  view.dispatch({
    effects: StateEffect.appendConfig.of([
      annotationDecorationsField,
      // Live formatting keeps each passage in sight, the active one
      // always.
      liveReveal.compute([annotationDecorationsField], (state) =>
        revealSource(state.field(annotationDecorationsField), (decoration) =>
          isActive(decoration) ? "active" : "annotation",
        ),
      ),
      // The mark is read at the press, as it was seen: the press moves the
      // caret, which may reveal the line's markup, the text then moving
      // under the pointer and the browser's click lost. Made active at the
      // release, unless the pointer moved (a selection being dragged).
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement | null;
          const id = target?.closest<HTMLElement>("[data-ann]")?.dataset.ann;
          pressed =
            id && event.button === 0
              ? { id, x: event.clientX, y: event.clientY }
              : undefined;
          return false;
        },
        mouseup(event) {
          const press = pressed;
          pressed = undefined;
          if (
            press &&
            active &&
            Math.hypot(event.clientX - press.x, event.clientY - press.y) <=
              CLICK_SLOP
          )
            active.set(press.id, "mark");
          return false;
        },
      }),
    ]),
  });
  recompute();
  const unsubscribe = index.subscribe(recompute);
  const unfollow = active?.subscribe(recompute);
  return () => {
    unsubscribe();
    unfollow?.();
  };
}
