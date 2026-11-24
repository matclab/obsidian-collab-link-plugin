export interface ResolvedRange {
  start: number;
  end: number;
}

export type OverlapKind = "disjoint" | "nested" | "crossing";

/** Classifies how two resolved `[start, end)` ranges relate — the
 * three-way distinction ADR-0012 needs: `"disjoint"` and `"nested"` are
 * both safe (representable by CriticMarkup's paired markers), `"crossing"`
 * is structurally not representable inline regardless of annotation type. */
export function classifyOverlap(
  a: ResolvedRange,
  b: ResolvedRange,
): OverlapKind {
  // Containment is checked before disjointness: a zero-width range (e.g. an
  // annotation whose anchored text was entirely deleted, anchor.ts) sitting
  // exactly on another range's boundary must classify the same way at
  // either end — checking disjointness first made a point at a range's
  // *end* boundary "disjoint" while the same point strictly inside was
  // "nested" (found by overlap.property.test.ts).
  if (
    (a.start <= b.start && b.end <= a.end) ||
    (b.start <= a.start && a.end <= b.end)
  ) {
    return "nested";
  }
  if (a.end <= b.start || b.end <= a.start) return "disjoint";
  return "crossing";
}

export interface ConflictPair {
  a: string;
  b: string;
}

/** All pairs, among `annotations`, whose resolved ranges cross — the set a
 * CriticMarkup export cannot represent unambiguously (ADR-0012). O(n²) on
 * the number of active annotations, accepted as negligible at review-sized
 * volumes (ADR-0012's own conclusion). Entries with a `null` range (an
 * unresolvable anchor, see anchor.ts) are skipped — nothing to classify. */
export function findCrossingConflicts(
  annotations: readonly { id: string; range: ResolvedRange | null }[],
): ConflictPair[] {
  const resolved = annotations.filter(
    (a): a is { id: string; range: ResolvedRange } => a.range !== null,
  );
  const conflicts: ConflictPair[] = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      if (!a || !b) continue;
      if (classifyOverlap(a.range, b.range) === "crossing") {
        conflicts.push({ a: a.id, b: b.id });
      }
    }
  }
  return conflicts;
}

/** ADR-0012 layer 1: checked before a *new* annotation is written to the
 * CRDT. Returns the id of the first existing annotation `proposed` would
 * cross, or `undefined` if it's only ever disjoint or nested against all
 * of `existing` — safe to create. */
export function findCreationConflict(
  existing: readonly { id: string; range: ResolvedRange }[],
  proposed: ResolvedRange,
): string | undefined {
  for (const candidate of existing) {
    if (classifyOverlap(candidate.range, proposed) === "crossing") {
      return candidate.id;
    }
  }
  return undefined;
}
