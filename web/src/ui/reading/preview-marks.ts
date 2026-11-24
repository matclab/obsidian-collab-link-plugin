import type { EditorView } from "@codemirror/view";
import type {
  AnnotationIndex,
  AnnotationType,
} from "../../../lib/src/index.js";
import { annotationPositions } from "../../editor/annotation-decorations.js";
import { count } from "../../perf/index.js";
import type { ActiveAnnotation } from "../../view-model/active-annotation.js";
import type { Preview } from "./preview.js";

/** An open annotation as the preview shows it. */
export interface PreviewMark {
  id: string;
  type: AnnotationType;
  /** The source line its excerpt starts on, from 0. */
  line: number;
  /** Where its excerpt starts on that line. */
  column: number;
  /** Its passage; for an addition, the text just before where it lands. */
  excerpt: string;
  /** A suggestion's proposed text, shown after its passage. */
  proposal?: string;
  active: boolean;
}

const MARKED = "oc-mark";
const INSERTED = "oc-mark-insert";
const CLASS: Record<AnnotationType, string> = {
  comment: "cm-annotation-comment",
  deletion: "cm-annotation-deletion",
  substitution: "cm-annotation-substitution",
  addition: "cm-annotation-addition",
};

/** Marks `marks` in a rendered preview, of a source whose line `n` (from
 * 0) is `sourceLine(n)`, whose top-level blocks
 * carry their source lines (`data-line`, `data-line-end`): on the passage
 * itself when its block shows its text as often as its source holds it,
 * as is in one text node (never inside a formula or a diagram) — the
 * passage is then the occurrence of the same rank —, else on the block
 * (`data-ann-block`, with the first one's `data-ann-type`, a bar at its
 * edge): the rendering hides some of it (a link's address)
 * or shows more (a proposal, an entity), and which one is the passage
 * cannot be told. The marks of a previous call are taken away first. The
 * same classes as the editor's marks; `data-ann` for a click and for the
 * margin. The annotation `reveal` opens the folded callouts that hold its
 * passage; marked on its block, the callout opens
 * when the passage is past its title line. */
export function markPreview(
  root: Element,
  marks: readonly PreviewMark[],
  sourceLine: (n: number) => string,
  reveal?: string,
): void {
  count("preview.marks");
  unmark(root);
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(":scope > [data-line]"),
  );
  for (const mark of marks) {
    const block = blocks.find(
      (candidate) =>
        Number(candidate.dataset.line) <= mark.line &&
        mark.line < Number(candidate.dataset.lineEnd),
    );
    if (!block) continue;
    const lines: string[] = [];
    const first = Number(block.dataset.line);
    for (let n = first; n < Number(block.dataset.lineEnd); n++) {
      lines.push(sourceLine(n));
    }
    const at =
      lines
        .slice(0, mark.line - first)
        .reduce((sum, line) => sum + line.length + 1, 0) + mark.column;
    const marked = mark.excerpt
      ? wrap(block, mark, lines.join("\n"), at)
      : undefined;
    if (marked) {
      if (mark.id === reveal) {
        for (
          let folded = marked.closest("details");
          folded && block.contains(folded);
          folded = folded.parentElement?.closest("details") ?? null
        ) {
          folded.open = true;
        }
      }
      continue;
    }
    if (
      mark.id === reveal &&
      mark.line > first &&
      block instanceof HTMLDetailsElement
    ) {
      block.open = true;
    }
    const ids = new Set(
      (block.dataset.annBlock ?? "").split(" ").filter(Boolean),
    );
    ids.add(mark.id);
    block.dataset.annBlock = [...ids].join(" ");
    // Its bar's colour: the first annotation's type.
    block.dataset.annType ??= mark.type;
    if (mark.active) block.dataset.annActive = "";
  }
}

/** Where a mark of the preview stands on screen: itself, or, folded away
 * in callouts, the title of the outermost folded one. */
export function shownAnchor(marked: Element): Element {
  let anchor = marked;
  for (
    let folded = marked.parentElement?.closest("details");
    folded;
    folded = folded.parentElement?.closest("details")
  ) {
    if (!folded.open)
      anchor = folded.querySelector(":scope > summary") ?? folded;
  }
  return anchor;
}

function unmark(root: Element): void {
  for (const inserted of Array.from(root.querySelectorAll(`.${INSERTED}`))) {
    inserted.remove();
  }
  const parents = new Set<Node>();
  for (const marked of Array.from(root.querySelectorAll(`.${MARKED}`))) {
    if (marked.parentNode) parents.add(marked.parentNode);
    marked.replaceWith(...Array.from(marked.childNodes));
  }
  for (const parent of parents) parent.normalize();
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>("[data-ann-block]"),
  )) {
    delete block.dataset.annBlock;
    delete block.dataset.annType;
    delete block.dataset.annActive;
  }
}

function span(
  tag: "span" | "ins" | "del",
  className: string,
  mark: PreviewMark,
  text?: string,
): HTMLElement {
  const element = document.createElement(tag);
  element.className = `${className}${mark.active ? " cm-annotation-active" : ""}`;
  element.dataset.ann = mark.id;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Where `excerpt` starts in `text`, overlapping occurrences included. */
function occurrences(text: string, excerpt: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(excerpt); at >= 0; ) {
    found.push(at);
    at = text.indexOf(excerpt, at + 1);
  }
  return found;
}

/** Wraps the passage of `mark`, at `at` in its block's source `text`, if
 * the block shows that text as often, in the order of the source, and
 * returns what it inserted. Text already marked counts (it was there), a
 * proposal shown does not (it was not), nor a callout's default title. */
function wrap(
  block: HTMLElement,
  mark: PreviewMark,
  text: string,
  at: number,
): HTMLElement | undefined {
  const inSource = occurrences(text, mark.excerpt);
  const rank = inSource.indexOf(at);
  if (rank < 0) return undefined;
  const shown: [Node, number][] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(
        `.math, .mermaid, .md-callout-default-title, .${INSERTED}`,
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const found of occurrences(node.textContent ?? "", mark.excerpt)) {
      shown.push([node, found]);
    }
  }
  if (shown.length !== inSource.length) return undefined;
  const [node, start] = shown[rank] as [Node, number];
  // Inside another annotation's mark: its block instead.
  if (node.parentElement?.closest("[data-ann]")) return undefined;
  const range = document.createRange();
  const end = start + mark.excerpt.length;
  if (mark.type === "addition") {
    range.setStart(node, end);
    range.collapse(true);
    const inserted = span(
      "ins",
      `${CLASS.addition} ${MARKED} ${INSERTED}`,
      mark,
      mark.proposal ?? "",
    );
    range.insertNode(inserted);
    return inserted;
  }
  range.setStart(node, start);
  range.setEnd(node, end);
  // What a suggestion takes out is a deletion, for a screen reader.
  const wrapper = span(
    mark.type === "comment" ? "span" : "del",
    `${CLASS[mark.type]} ${MARKED}`,
    mark,
  );
  range.surroundContents(wrapper);
  if (mark.type === "substitution" && mark.proposal !== undefined) {
    wrapper.after(
      span(
        "ins",
        `cm-annotation-replacement ${MARKED} ${INSERTED}`,
        mark,
        mark.proposal,
      ),
    );
  }
  return wrapper;
}

/** Keeps the annotations marked in `preview`: after each of
 * its renderings, when the index notifies, when the active annotation
 * changes — only while it is shown. Positions come from the editor's
 * marks, which CodeMirror maps through every edit. A click on a mark, or
 * on a marked block, makes its annotation active. An annotation newly
 * active opens the folded callouts holding it, once: a reader may fold
 * them again. */
export function attachPreviewMarks(
  preview: Preview,
  view: EditorView,
  index: AnnotationIndex,
  active: ActiveAnnotation,
): void {
  // The active annotation last revealed, so that it is revealed once.
  let revealed: string | undefined;
  const run = () => {
    if (!preview.visible) return;
    const reveal = active.id === revealed ? undefined : active.id;
    revealed = active.id;
    const current = index.current();
    const positions = annotationPositions(view);
    const doc = view.state.doc;
    const marks: PreviewMark[] = [];
    for (const annotation of current.annotations) {
      const range = annotation.range;
      if (annotation.status !== "open" || !range) continue;
      const start = Math.min(
        positions.get(annotation.id) ?? range.start,
        doc.length,
      );
      const line = doc.lineAt(start);
      const end = Math.min(start + (range.end - range.start), doc.length);
      // An addition lands after the text just before it, on its line.
      const [from, to] =
        annotation.type === "addition"
          ? [Math.max(line.from, start - 12), start]
          : [start, end];
      const proposed = current.previews.get(annotation.id);
      marks.push({
        id: annotation.id,
        type: annotation.type,
        line: line.number - 1,
        column: from - line.from,
        excerpt: doc.sliceString(from, to),
        ...(proposed?.kind === "valid" && { proposal: proposed.text }),
        active: annotation.id === active.id,
      });
    }
    markPreview(
      preview.root,
      marks,
      (n) => (n < doc.lines ? doc.line(n + 1).text : ""),
      reveal,
    );
  };
  preview.onRendered(run);
  index.subscribe(run);
  active.subscribe(run);
  preview.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const marked = target?.closest<HTMLElement>("[data-ann], [data-ann-block]");
    const id = marked?.dataset.ann ?? marked?.dataset.annBlock?.split(" ")[0];
    if (id) active.set(id, "mark");
  });
}
