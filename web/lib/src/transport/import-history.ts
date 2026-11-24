import {
  type ImportStatus,
  type LoroDoc,
  type PeerID,
  decodeImportBlobMeta,
} from "loro-crdt";
import { count, span } from "../perf/index.js";
import { isWasmTrap } from "./fatal.js";

/** Imports the updates of a history reply, in order, as few times as
 * possible: runs of updates in one `importBatch` (one Loro event instead of
 * one per entry, docs/phase-4ter-*.md, decision 3), each snapshot on its
 * own. A compacted journal starts with a snapshot (full since ADR-0017,
 * shallow in journals compacted before), and Loro 1.16 silently drops
 * *everything* when a shallow snapshot is part of a batch
 * imported into an empty doc: empty state, a non-null `pending`, no
 * exception (found by the e2e compaction test; `import-history.property.
 * test.ts` checks the result equals importing entry by entry). Adds to
 * `pending` what the imports left waiting for a dependency.
 *
 * An entry that isn't a Loro update, or that Loro refuses, is skipped and
 * reported to `onInvalid` (docs/phase-5-modele-acces.md, decision 10): a
 * reviewer holds the key and may publish anything on its channel; one bad
 * entry must not keep the others out. A batch that fails is imported
 * again entry by entry, to isolate the culprit (importing is
 * idempotent). */
export function importHistory(
  doc: LoroDoc,
  updates: Uint8Array[],
  pending: PendingOps = new Map(),
  onInvalid: () => void = () => {},
): PendingOps {
  const importOne = (update: Uint8Array) => {
    count("loro.import");
    try {
      addPending(
        pending,
        span("import", () => doc.import(update)),
      );
    } catch (error) {
      if (isWasmTrap(error)) throw error; // the document is poisoned (phase 9, L4)
      count("import.invalid");
      onInvalid();
    }
  };
  let run: Uint8Array[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const batch = run;
    run = [];
    count("loro.import");
    try {
      addPending(
        pending,
        span("import", () => doc.importBatch(batch)),
      );
    } catch (error) {
      if (isWasmTrap(error)) throw error; // no use trying one by one (phase 9, L4)
      for (const update of batch) importOne(update);
    }
  };
  for (const update of updates) {
    const kind = updateKind(update);
    if (kind === "invalid") {
      count("import.invalid");
      onInvalid();
    } else if (kind === "snapshot") {
      flush();
      importOne(update);
    } else {
      run.push(update);
    }
  }
  flush();
  return pending;
}

/** What `bytes` claim to be, from their header alone. */
export function updateKind(
  bytes: Uint8Array,
): "update" | "snapshot" | "invalid" {
  try {
    return decodeImportBlobMeta(bytes, false).mode.includes("snapshot")
      ? "snapshot"
      : "update";
  } catch {
    return "invalid";
  }
}

/** Operations an import left waiting for their dependencies: per Loro
 * peer, the counter they reach. */
export type PendingOps = Map<PeerID, number>;

export function addPending(into: PendingOps, status: ImportStatus): void {
  for (const [peer, { end }] of status.pending ?? []) {
    into.set(peer, Math.max(into.get(peer) ?? 0, end));
  }
}

/** Drops from `pending` what `doc` now holds (its dependencies arrived);
 * returns whether anything is still waiting. */
export function stillPending(doc: LoroDoc, pending: PendingOps): boolean {
  const version = doc.oplogVersion();
  for (const [peer, end] of pending) {
    if ((version.get(peer) ?? 0) >= end) pending.delete(peer);
  }
  return pending.size > 0;
}
