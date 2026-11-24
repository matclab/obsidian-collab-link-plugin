import {
  type Annotation,
  classifyOverlap,
  findCrossingConflicts,
} from "../../lib/src/index.js";
import { formatNote } from "./notes.js";

/** An annotation with its range already resolved (non-null) — what
 * `formatCriticMarkup` actually needs; `listAnnotations` may still return
 * `range: null` for an unresolvable anchor (anchor.ts), which the caller
 * must filter out or resolve before exporting. `proposed`: an addition's
 * or substitution's text, decoded from its detached change by the caller
 * (`checkDetachedChange`, ADR-0018) — it is not in `content`. */
export type ResolvedAnnotation = Annotation & {
  range: { start: number; end: number };
  proposed?: string;
};

interface TreeNode {
  annotation: ResolvedAnnotation;
  children: TreeNode[];
}

/** Builds a forest from containment: each node's `children` are the
 * annotations directly nested inside it (not transitively, via some
 * intermediate child) — ADR-0012's "nested" relation, assumed already
 * validated as free of "crossing" pairs by the caller (see the guard
 * below). Annotations with an identical range are ordered by their
 * position in `annotations`, the earlier one treated as the ancestor, so
 * containment forms a strict order even on ties. */
function buildForest(annotations: readonly ResolvedAnnotation[]): TreeNode[] {
  function contains(
    outerIndex: number,
    outer: ResolvedAnnotation,
    innerIndex: number,
    inner: ResolvedAnnotation,
  ): boolean {
    if (outerIndex === innerIndex) return false;
    // An addition is a point (ADR-0018: its text is not in content).
    if (outer.type === "addition") return false;
    // A point (an addition, a comment once read back) on the boundary of
    // a substitution or a comment is written outside, before or after:
    // their markers hold no marker at all. A deletion's may: a point at
    // its end stays inside, where it does not read back as its note.
    if (
      (outer.type === "substitution" || outer.type === "comment") &&
      inner.range.start === inner.range.end &&
      (inner.range.start === outer.range.start ||
        inner.range.start === outer.range.end)
    ) {
      return false;
    }
    const strictlyContains =
      outer.range.start <= inner.range.start &&
      inner.range.end <= outer.range.end;
    if (!strictlyContains) return false;
    if (
      outer.range.start === inner.range.start &&
      outer.range.end === inner.range.end
    ) {
      return outerIndex < innerIndex; // tie-break identical ranges by order
    }
    return true;
  }

  function directParentIndex(innerIndex: number): number | undefined {
    let parent: number | undefined;
    for (let i = 0; i < annotations.length; i++) {
      const candidate = annotations[i];
      const inner = annotations[innerIndex];
      if (!candidate || !inner) continue;
      if (!contains(i, candidate, innerIndex, inner)) continue;
      // The direct parent is the *smallest* container among all containers;
      // among identical ranges, the latest one (they nest in order).
      if (
        parent === undefined ||
        rangeWidth(candidate) <=
          rangeWidth(annotations[parent] as ResolvedAnnotation)
      ) {
        parent = i;
      }
    }
    return parent;
  }

  function rangeWidth(a: ResolvedAnnotation): number {
    return a.range.end - a.range.start;
  }

  const nodes: TreeNode[] = annotations.map((annotation) => ({
    annotation,
    children: [],
  }));
  const roots: TreeNode[] = [];
  for (let i = 0; i < annotations.length; i++) {
    const parentIndex = directParentIndex(i);
    const node = nodes[i];
    if (!node) continue;
    if (parentIndex === undefined) {
      roots.push(node);
    } else {
      nodes[parentIndex]?.children.push(node);
    }
  }
  // In text order; a point at the start of a range comes before it, and
  // a comment before an addition at the same point: right after it, the
  // comment would read back as the addition's note.
  const rank = ({ annotation: { range, type } }: TreeNode) =>
    range.start !== range.end ? 2 : type === "comment" ? 0 : 1;
  const byPosition = (a: TreeNode, b: TreeNode) =>
    a.annotation.range.start - b.annotation.range.start || rank(a) - rank(b);
  for (const node of nodes) node.children.sort(byPosition);
  roots.sort(byPosition);
  return roots;
}

function openMarker(annotation: ResolvedAnnotation): string {
  switch (annotation.type) {
    case "addition":
      return "{++";
    case "deletion":
      return "{--";
    case "substitution":
      return "{~~";
    case "comment":
      return "";
  }
}

function closeMarker(annotation: ResolvedAnnotation): string {
  switch (annotation.type) {
    case "addition":
      return "++}";
    case "deletion":
      return "--}";
    case "substitution":
      return `~>${annotation.proposed ?? ""}~~}`;
    case "comment":
      return "";
  }
}

/** The names given while writing, in the text's order (ADR-0034 §1):
 * one series per prefix, from 1. */
interface Naming {
  comments: ResolvedAnnotation[];
  suggestions: ResolvedAnnotation[];
}

function reference(annotation: ResolvedAnnotation, naming: Naming): string {
  const series =
    annotation.type === "comment" ? naming.comments : naming.suggestions;
  series.push(annotation);
  return `[^${annotation.type === "comment" ? "cm" : "sg"}-${series.length}]`;
}

/** Renders `[from, to)` of `text`, wrapping `nodes` (already ordered,
 * non-overlapping at this level) with their markers, each followed by its
 * note's reference. */
function renderSegment(
  text: string,
  from: number,
  to: number,
  nodes: readonly TreeNode[],
  naming: Naming,
): string {
  let out = "";
  let cursor = from;
  for (const { annotation, children } of nodes) {
    const { start, end } = annotation.range;
    out += text.slice(cursor, start);
    if (annotation.type === "addition") {
      out += `{++${annotation.proposed ?? ""}++}`;
    } else if (annotation.type === "substitution") {
      // Its old text holds no marker: what it contains is not written.
      out +=
        openMarker(annotation) +
        text.slice(start, end) +
        closeMarker(annotation);
    } else if (annotation.type === "comment" && start === end) {
      // A point: its reference alone (ADR-0034 §1).
    } else {
      const [open, close] =
        annotation.type === "comment" ? ["{==", "==}"] : ["{--", "--}"];
      out += open + renderSegment(text, start, end, children, naming) + close;
    }
    out += reference(annotation, naming);
    cursor = end;
  }
  out += text.slice(cursor, to);
  return out;
}

/** The annotations `formatCriticMarkup` considers: open, and with their
 * proposed text when they need one. */
function exportable(
  annotations: readonly ResolvedAnnotation[],
): ResolvedAnnotation[] {
  return annotations.filter(
    (a) =>
      a.status === "open" &&
      ((a.type !== "addition" && a.type !== "substitution") ||
        a.proposed !== undefined),
  );
}

/** How the comments are written (ADR-0034 §4): over their range, in
 * `{==…==}`, unless it would cross a marker already placed — any
 * suggestion's, or an earlier comment's in the text's order —: then as a
 * point at the end of its range, what it covered at the head of its text.
 * Returns the annotations as written, and how many comments went back to
 * a point. */
function layout(
  annotations: readonly ResolvedAnnotation[],
  text: string,
): { written: ResolvedAnnotation[]; pointed: number } {
  const suggestions = annotations.filter((a) => a.type !== "comment");
  const comments = annotations
    .filter((a) => a.type === "comment")
    .sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end);
  const placed: ResolvedAnnotation[] = [...suggestions];
  const written: ResolvedAnnotation[] = [];
  let pointed = 0;
  for (const comment of comments) {
    const crosses = placed.some(
      (other) => classifyOverlap(comment.range, other.range) === "crossing",
    );
    if (!crosses) {
      written.push(comment);
      placed.push(comment);
      continue;
    }
    pointed++;
    const { range } = comment;
    written.push({
      ...comment,
      range: { start: range.end, end: range.end },
      body: `${covering(text.slice(range.start, range.end))}${comment.body ?? ""}`,
    });
  }
  // Comments first: on a tie, the outer one — a substitution holds no
  // marker, and a comment's highlight may hold a suggestion.
  return { written: [...written, ...suggestions], pointed };
}

/** What a comment covers, for the reader of the file, where only its
 * point survives: "word — ", "first … last — ", or nothing for a point. */
function covering(covered: string): string {
  const words = covered.split(/\s+/).filter((word) => word !== "");
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) return "";
  return words.length === 1 ? `${first} — ` : `${first} … ${last} — `;
}

/** Ids of what a substitution contains: CriticMarkup cannot write it (the
 * old text is plain text), it is left out. */
function insideSubstitutions(forest: readonly TreeNode[]): string[] {
  const all = (node: TreeNode): string[] => [
    node.annotation.id,
    ...node.children.flatMap(all),
  ];
  return forest.flatMap((node) =>
    node.annotation.type === "substitution"
      ? node.children.flatMap(all)
      : insideSubstitutions(node.children),
  );
}

/** What stands in the way of writing `annotations` (those
 * `formatCriticMarkup` considers): crossing pairs, which refuse the export
 * (ADR-0012 layer 3), and the ids it leaves out, inside a substitution. */
export function exportObstacles(
  text: string,
  annotations: readonly ResolvedAnnotation[],
): {
  crossing: number;
  leftOut: string[];
} {
  const { written } = layout(exportable(annotations), text);
  return {
    crossing: findCrossingConflicts(written).length,
    leftOut: insideSubstitutions(buildForest(written)),
  };
}

/** Serializes `text` (the clean `content`) plus `annotations` into
 * CriticMarkup with notes — the export half of ADR-0003, in ADR-0034's
 * form. Only annotations still `status: "open"` are considered at all: a
 * closed one's effect on `content` (if any) is already applied, and the
 * file has no form for a decision. An addition or substitution without
 * its `proposed` text (its change pending or invalid) is left out too:
 * there is nothing sound to write, and so is what a substitution contains
 * (`exportObstacles`). A comment is written over its range, or as a point
 * when its range would cross another (`layout`). Refuses (ADR-0012 layer
 * 3) if suggestions cross: a crossing pair has no paired-marker
 * representation. */
export function formatCriticMarkup(
  text: string,
  annotations: readonly ResolvedAnnotation[],
): string {
  return writeCriticMarkup(text, annotations).markdown;
}

/** `formatCriticMarkup`, and how many comments went back to a point. */
export function writeCriticMarkup(
  text: string,
  annotations: readonly ResolvedAnnotation[],
): { markdown: string; pointed: number } {
  const { written, pointed } = layout(exportable(annotations), text);
  const conflicts = findCrossingConflicts(written);
  if (conflicts.length > 0) {
    const pairs = conflicts.map((c) => `${c.a}×${c.b}`).join(", ");
    throw new Error(
      `cannot export: crossing annotation pairs must be resolved first: ${pairs}`,
    );
  }
  const naming: Naming = { comments: [], suggestions: [] };
  const body = renderSegment(
    text,
    0,
    text.length,
    buildForest(written),
    naming,
  );
  const notes = [
    ...naming.comments.map((a, i) => note(`cm-${i + 1}`, a, a.body ?? "")),
    ...naming.suggestions.map((a, i) => note(`sg-${i + 1}`, a, a.note ?? "")),
  ];
  return {
    markdown: notes.length === 0 ? body : `${body}\n\n${notes.join("\n\n")}\n`,
    pointed,
  };
}

/** An annotation's note: its own entry, then its replies (ADR-0035 §6). */
function note(
  name: string,
  annotation: ResolvedAnnotation,
  text: string,
): string {
  return formatNote(name, [
    { author: annotation.author, createdAt: annotation.createdAt, text },
    ...annotation.replies.map((reply) => ({
      author: reply.author,
      createdAt: reply.createdAt,
      text: reply.body,
    })),
  ]);
}
