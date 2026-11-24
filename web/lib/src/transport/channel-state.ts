import { type LoroDoc, type PeerID, VersionVector } from "loro-crdt";
import { type PendingOps, stillPending } from "./import-history.js";
import type { ChannelName } from "./protocol.js";

/** A Loro channel's transport state, as stored (ADR-0022 §1). */
export interface ChannelState {
  channel: Exclude<ChannelName, "decisions">;
  /** Where to rejoin from: `confirmedSeq`, or the cursor before an import
   * that left operations waiting while they still wait (R-L3) — a snapshot
   * doesn't hold them, and a join past them would never bring them back. */
  cursor: number;
  /** Own peer ids with operations not all acked, and how far the server
   * acked each (ADR-0015); a peer with everything acked is left out
   * (R-L1). */
  own: { peer: string; acked: number }[];
  /** Adopted changes not yet acked, in order (R-A1, R-A2). */
  adopted: {
    change: Uint8Array;
    ownBefore: { peer: string; counter: number }[];
  }[];
}

/** What the connection keeps of one Loro channel while it runs. */
export interface ChannelRuntime {
  channel: Exclude<ChannelName, "decisions">;
  doc: LoroDoc;
  // The Loro peer ids this client wrote with on this channel: whose
  // operations it publishes (ADR-0015). Every page makes fresh docs with a
  // random id; any id seen in a local batch is kept, should it change.
  ownPeers: Set<PeerID>;
  // Per own peer, the counter up to which the server acked its
  // operations: never ahead of an ack, so whatever follows is published
  // again after a drop. Empty: nothing acked yet, so edits made before
  // connecting are published too.
  ackedOwn: VersionVector;
  // Changes this client adopted (imported, not its own operations, ADR-0018)
  // and must publish itself, each alone in its frame, until acked (R-A2);
  // with, per own peer, the counter its own operations had reached when
  // it was adopted: those go first (a change it suggested itself may
  // depend on them), those typed after go after it (they may depend on
  // it) — R-A1.
  adopted: { change: Uint8Array; ownBefore: Map<PeerID, number> }[];
  // A frame of this channel awaits its ack: at most one at a time, so
  // frames never overlap, and commits made meanwhile leave together.
  publishing: boolean;
  publishTimer: ReturnType<typeof setTimeout> | undefined;
  lastPublishAt: number;
  // Ops this client has published on this channel since the last
  // compaction it triggered for that same channel (or since connecting, if
  // it never has) — the input to `shouldCompact` (decision 6/decision 5).
  // A per-client, per-channel heuristic, not a server-confirmed count of
  // the whole channel's activity: this client only reliably learns about
  // its own ops (via acks), not every peer's, and channels compact
  // independently since they accumulate ops at different rates.
  opsSinceLastCompaction: number;
  // The highest seq this client has actually been shown, for this
  // channel, via a real HistoryReply, and imported — never advanced by a
  // publish ack (`docs/adr/0011-*.md`). An ack only proves this client's
  // own op was journaled; it says nothing about whether concurrently
  // journaled operations from other peers, with a *lower* seq but still in
  // flight as a live push, have been imported yet. The `since` of every
  // join of this channel: the differential rejoin `triggerCompaction` does
  // before compacting, and every reconnect (ADR-0015: resuming from a
  // cursor advanced by acks skipped such an operation for good, now that
  // no peer publishes again what it received).
  confirmedSeq: number;
  // Operations imported on this channel but waiting for a dependency this
  // client doesn't hold: a snapshot taken now would leave them out, and a
  // compaction would drop the entry that carries them (R-A3).
  pending: PendingOps;
  // Compactions deferred in a row because of them.
  deferredCompactions: number;
  // The cursor from before the import that left `pending` non-empty, while
  // it may still be: what is stored instead of `confirmedSeq` (R-L3).
  frozenCursor: number | undefined;
}

/** A channel's runtime, resumed from what an earlier page stored, if
 * anything (ADR-0022). */
export function restoreChannel(
  channel: Exclude<ChannelName, "decisions">,
  doc: LoroDoc,
  stored: ChannelState | undefined,
): ChannelRuntime {
  const ackedOwn = new VersionVector(undefined);
  for (const { peer, acked } of stored?.own ?? []) {
    ackedOwn.setEnd({ peer: peer as PeerID, counter: acked });
  }
  return {
    channel,
    doc,
    ownPeers: new Set([
      doc.peerIdStr,
      ...(stored?.own ?? []).map(({ peer }) => peer as PeerID),
    ]),
    ackedOwn,
    publishing: false,
    publishTimer: undefined,
    lastPublishAt: Number.NEGATIVE_INFINITY,
    opsSinceLastCompaction: 0,
    confirmedSeq: stored?.cursor ?? 0,
    adopted: (stored?.adopted ?? []).map(({ change, ownBefore }) => ({
      change,
      ownBefore: new Map(
        ownBefore.map(({ peer, counter }) => [peer as PeerID, counter]),
      ),
    })),
    pending: new Map(),
    deferredCompactions: 0,
    frozenCursor: undefined,
  };
}

/** What a later page needs to resume this channel, read now. */
export function persistChannel(runtime: ChannelRuntime): ChannelState {
  const version = runtime.doc.oplogVersion();
  const own: ChannelState["own"] = [];
  for (const peer of runtime.ownPeers) {
    const acked = runtime.ackedOwn.get(peer) ?? 0;
    if ((version.get(peer) ?? 0) > acked) own.push({ peer, acked });
  }
  return {
    channel: runtime.channel,
    cursor: storedCursor(runtime),
    own,
    adopted: runtime.adopted.map(({ change, ownBefore }) => ({
      change,
      ownBefore: [...ownBefore].map(([peer, counter]) => ({
        peer,
        counter,
      })),
    })),
  };
}

// R-L3. Lower than needed at worst (stale entries in `pending`, or a
// second wait starting before the first is seen over): a longer rejoin.
export function freezeIfPending(runtime: ChannelRuntime, cursorBefore: number) {
  if (runtime.pending.size > 0 && runtime.frozenCursor === undefined) {
    runtime.frozenCursor = cursorBefore;
  }
}

export function storedCursor(runtime: ChannelRuntime): number {
  if (
    runtime.frozenCursor !== undefined &&
    !stillPending(runtime.doc, runtime.pending)
  ) {
    runtime.frozenCursor = undefined;
  }
  return runtime.frozenCursor ?? runtime.confirmedSeq;
}
