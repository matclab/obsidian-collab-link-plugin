import type { LoroDoc } from "loro-crdt";
import { span } from "../perf/index.js";
import { listAnnotations } from "./model.js";
import { type ConflictPair, findCrossingConflicts } from "./overlap.js";

/** The current crossing conflicts among "active" (`status: "open"`)
 * annotations only — once an annotation is accepted/rejected/resolved,
 * its effect on `content` (if any) is already applied and it no longer
 * needs a CriticMarkup marker at all (ADR-0012's "annotations actives"): a
 * stale range crossing a closed annotation's range isn't a conflict
 * anyone still needs to resolve. Exposed on its own (not just inside
 * `watchConflicts`) so callers that already know they changed something —
 * e.g. the UI panel right after a local accept/reject/resolve — can
 * refresh immediately rather than wait for an import to trigger it. */
export function computeActiveConflicts(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
): ConflictPair[] {
  return span("conflicts", () => {
    const active = listAnnotations(contentDoc, annotationsDoc).filter(
      (a) => a.status === "open",
    );
    return findCrossingConflicts(active);
  });
}

/** Recomputes `computeActiveConflicts` after every CRDT import on either
 * `contentDoc` or `annotationsDoc` (ADR-0012 layer 2) — a crossing can
 * appear from a merge of two individually-valid concurrent creations (case
 * 2) or from the two channels arriving out of step (case 3: an annotation
 * whose content hasn't arrived yet resolves to `null`, ADR-0012),
 * neither of which touches `annotationsDoc` by itself. Local edits are not watched here:
 * layer 1 (the UI creation guard, phase-4 §4) already prevents a local
 * annotation creation from introducing a crossing, and a local
 * accept/reject/resolve is the caller's own action to refresh after (see
 * `computeActiveConflicts`). Returns an unsubscribe function. */
export function watchConflicts(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  onConflictsChanged: (conflicts: ConflictPair[]) => void,
): () => void {
  function recompute(): void {
    onConflictsChanged(computeActiveConflicts(contentDoc, annotationsDoc));
  }

  const unsubContent = contentDoc.subscribe((event) => {
    if (event.by === "import") recompute();
  });
  const unsubAnnotations = annotationsDoc.subscribe((event) => {
    if (event.by === "import") recompute();
  });

  return () => {
    unsubContent();
    unsubAnnotations();
  };
}
