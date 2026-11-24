/** Starting threshold for the operation-count trigger
 * (docs/phase-2-persistance-reprise.md decision 6) — to be adjusted
 * empirically, same reasoning as T4 (choice/loro/results/t4-report.md). */
export const DEFAULT_COMPACTION_THRESHOLD = 1000;

/** Given how many operations have been published since the document's
 * journal was last compacted, decides whether this client should trigger a
 * compaction now. Pure and deterministic — no network, no DOM, no
 * knowledge of the CRDT or the transport protocol (AGENTS.md §1.2) — so
 * it's testable in isolation from everything else in the compaction flow. */
export function shouldCompact(
  opsSinceLastCompaction: number,
  threshold: number = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  return opsSinceLastCompaction >= threshold;
}
