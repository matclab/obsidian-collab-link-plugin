import type { LoroDoc } from "loro-crdt";
import { span } from "../perf/index.js";
import type { AnnotationIndex } from "./annotation-index.js";
import type { ConfirmedProposal, DecisionLog } from "./decisions.js";
import { checkDetachedChange, createDetachedChange } from "./detached.js";
import {
  type Annotation,
  type AnnotationDraft,
  draftAnnotation,
  idsWithStatus,
  resolveAnnotation,
  updateStatus,
  writeAnnotation,
} from "./model.js";

/** Applies the confirmed decision of every open annotation that has one
 * (ADR-0013 rule 3, effects per ADR-0018 decision 4):
 *
 * | type         | accept                                   | reject  |
 * |--------------|------------------------------------------|---------|
 * | deletion     | deletes the range                        | nothing |
 * | addition     | imports the change                       | nothing |
 * | substitution | deletes the old text, imports the change | nothing |
 *
 * and a comment's confirmed resolution resolves it. The range is the one
 * resolved *now* (phase-4bis decision 6 (a): text typed inside it meanwhile
 * goes too); the change is the one the winning proposal carries, never the
 * annotation's (which a reviewer may rewrite), and only if its check says
 * it is one insertion (`checkDetachedChange`): void or invalid, the
 * acceptance wins with no effect. Then writes the winning decision as the
 * status. That status is derived — every peer writes the same value from
 * the same journal — and doubles as the "applied" mark: an annotation no
 * longer `open` is never applied again, so a peer reloading much later
 * won't delete what was typed at that spot since. Idempotent; safe to call
 * on any change.
 *
 * An imported change is not this peer's own operations: ADR-0015 never
 * publishes it. `adopt` gets each change right after it is imported, in
 * the same turn, for the transport to publish it before anything typed
 * after (docs/phase-5-modele-acces.md, analysis A, R-A1). Only editors
 * apply effects (decision 2). */
export function applyDecisionEffects(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  log: Pick<DecisionLog, "winner" | "resolution">,
  adopt: Adopt = () => {},
): void {
  span("effects", () =>
    applyDecisionEffectsUnmeasured(contentDoc, annotationsDoc, log, adopt),
  );
}

/** Publishes a change this peer imported (`DocumentConnection.adopt`). */
export type Adopt = (change: Uint8Array) => void;

function applyDecisionEffectsUnmeasured(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  log: Pick<DecisionLog, "winner" | "resolution">,
  adopt: Adopt,
): void {
  for (const id of idsWithStatus(annotationsDoc, "open", ["comment"])) {
    if (log.resolution(id)) updateStatus(annotationsDoc, id, "resolved");
  }
  const ids = idsWithStatus(annotationsDoc, "open", [
    "addition",
    "deletion",
    "substitution",
  ]);
  for (const id of ids) {
    const winner = log.winner(id);
    if (!winner) continue;
    if (winner.decision === "accept") {
      // Resolved only now, and alone: applying one effect shifts the
      // others, and resolving the undecided ones would make this quadratic.
      const annotation = resolveAnnotation(contentDoc, annotationsDoc, id);
      if (!annotation) continue;
      if (!accept(contentDoc, annotation, winner, adopt)) continue; // wait
    }
    updateStatus(
      annotationsDoc,
      id,
      winner.decision === "accept" ? "accepted" : "rejected",
    );
  }
  importAcceptedChanges(contentDoc, annotationsDoc, log, adopt);
}

/** Changes known to be in a content doc: once imported, always there. */
const imported = new WeakMap<LoroDoc, Set<string>>();

/** The status is not enough of an "applied" mark for an imported change:
 * it is not the importer's own operations (ADR-0015), so the status can
 * reach a peer that never got the change. Importing is idempotent, so an
 * accepted addition's or substitution's change is imported wherever it is
 * missing, whatever the status (the old text's deletion is the applier's
 * own operation, and stays guarded by the status). */
function importAcceptedChanges(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  log: Pick<DecisionLog, "winner">,
  adopt: Adopt,
): void {
  const known = imported.get(contentDoc) ?? new Set<string>();
  imported.set(contentDoc, known);
  for (const id of idsWithStatus(annotationsDoc, "accepted", [
    "addition",
    "substitution",
  ])) {
    if (known.has(id)) continue;
    const winner = log.winner(id);
    if (winner?.decision !== "accept" || winner.void || !winner.change) {
      continue;
    }
    const verdict = checkDetachedChange(contentDoc, id, winner.change);
    if (verdict.kind === "valid") {
      contentDoc.import(winner.change);
      adopt(winner.change);
    }
    if (verdict.kind !== "pending") known.add(id);
  }
}

/** Applies an acceptance's effect; `false` when it must wait (its range, or
 * its change's dependencies, haven't arrived: the channels sync
 * independently). */
function accept(
  contentDoc: LoroDoc,
  annotation: Annotation,
  winner: ConfirmedProposal,
  adopt: Adopt,
): boolean {
  const { range } = annotation;
  if (annotation.type === "deletion") {
    if (range === null) return false;
    deleteRange(contentDoc, range);
    return true;
  }
  if (winner.void || !winner.change) return true; // wins, no effect
  const verdict = checkDetachedChange(contentDoc, annotation.id, winner.change);
  if (verdict.kind === "pending") return false;
  if (verdict.kind === "invalid") return true; // wins, no effect
  if (annotation.type === "substitution") {
    if (range === null) return false;
    deleteRange(contentDoc, range);
  }
  if (verdict.kind === "valid") {
    contentDoc.import(winner.change);
    adopt(winner.change);
  }
  return true;
}

function deleteRange(
  contentDoc: LoroDoc,
  range: { start: number; end: number },
): void {
  if (range.end <= range.start) return;
  contentDoc.getText("content").delete(range.start, range.end - range.start);
  contentDoc.commit();
}

/** Keeps `applyDecisionEffects` up to date, as a writer of the shared
 * index (`annotation-index.ts`): after every confirmed batch and every
 * import on either channel (what can make a waiting decision applicable:
 * its annotation, or the content its range needs), before the readers
 * render. Local typing doesn't notify the index, so costs nothing here.
 * The index must have been given `log`, or confirmed batches go unseen.
 * Returns an unsubscribe. */
export function watchDecisionEffects(
  index: AnnotationIndex,
  log: Pick<DecisionLog, "winner" | "resolution">,
  adopt: Adopt = () => {},
): () => void {
  return index.subscribeWriter(() =>
    applyDecisionEffects(index.contentDoc, index.annotationsDoc, log, adopt),
  );
}

/** Proposes new text at `at` (ADR-0018): the text goes into a detached
 * change, made on a fork of `contentDoc` in this very call, and an open
 * `addition` annotation, anchored at the insertion point (zero-width),
 * carries it. `contentDoc` is left untouched: nothing to publish on
 * `content`. Accepting imports the change; rejecting does nothing. A
 * zero-width anchor can never cross an existing range. Throws on an empty
 * text, or on an empty document (no cursor to anchor to). */
export function suggestAddition(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  input: AdditionInput,
): string {
  return writeAnnotation(annotationsDoc, draftAddition(contentDoc, input));
}

export interface AdditionInput {
  at: number;
  text: string;
  author: string;
  note?: string;
  /** For an import only (ADR-0034). */
  createdAt?: number;
}

/** `suggestAddition`, drafted and not yet written (ID-12): the detached
 * change made now, on a fork. */
export function draftAddition(
  contentDoc: LoroDoc,
  input: AdditionInput,
): AnnotationDraft {
  const id = crypto.randomUUID();
  const change = createDetachedChange(contentDoc, id, input.at, input.text);
  return draftAnnotation(
    contentDoc,
    {
      type: "addition",
      start: input.at,
      end: input.at,
      author: input.author,
      change,
      ...(input.note !== undefined && { note: input.note }),
      ...(input.createdAt !== undefined && { createdAt: input.createdAt }),
    },
    id,
  );
}
