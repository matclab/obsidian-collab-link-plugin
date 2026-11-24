import type { LoroDoc, PeerID } from "loro-crdt";
import type { ChannelRuntime } from "./channel-state.js";
import { FRAME_OVERHEAD } from "./protocol.js";

/** A run of one peer's operations, by counters. */
export type Span = { id: { peer: PeerID; counter: number }; len: number };

/** The own operations of this channel not acked yet, to publish next
 * (ADR-0015) — up to `head`, the oldest adopted change not acked, if any.
 *
 * R-A1: journaled in the order the client did things — its own operations
 * up to an adoption, the adopted change, then what follows. An operation
 * typed after the change may depend on it; the change, if this client
 * suggested it, may depend on what it typed before. Either journaled
 * later, the dependent waits, and a compaction drops it
 * (docs/phase-5-modele-acces.md, analysis A). One frame in flight per
 * channel keeps the order. */
export function ownSpans(
  runtime: ChannelRuntime,
  head: ChannelRuntime["adopted"][number] | undefined,
): Span[] {
  const spans: Span[] = [];
  const current = runtime.doc.oplogVersion();
  for (const peer of runtime.ownPeers) {
    const start = runtime.ackedOwn.get(peer) ?? 0;
    const end = head
      ? (head.ownBefore.get(peer) ?? 0)
      : (current.get(peer) ?? 0);
    if (end > start)
      spans.push({ id: { peer, counter: start }, len: end - start });
  }
  // The current peer last: what this page typed may depend on what an
  // earlier page did (stored peers, R-L1), never the reverse — if the
  // frame must be split, the earlier operations leave first.
  spans.sort(
    (x, y) =>
      Number(x.id.peer === runtime.doc.peerIdStr) -
      Number(y.id.peer === runtime.doc.peerIdStr),
  );
  return spans;
}

/** The first `counters` counters of `spans`, in order. */
function prefix(spans: Span[], counters: number): Span[] {
  const taken: Span[] = [];
  let left = counters;
  for (const span of spans) {
    if (left <= 0) break;
    const len = Math.min(span.len, left);
    taken.push({ id: span.id, len });
    left -= len;
  }
  return taken;
}

/** The longest prefix of `spans` whose export fits in one frame
 * (docs/protocol/04-obligations.md, O-18): halved until it does. The rest
 * leaves in the next frames, once this one is acked. A single operation
 * too large for any frame is returned as is, and `trySend` refuses it. */
export function fitting(
  doc: LoroDoc,
  spans: Span[],
  maxMessageBytes: number,
): { sent: Span[]; update: Uint8Array } {
  let sent = spans;
  let update = doc.export({ mode: "updates-in-range", spans: sent });
  while (FRAME_OVERHEAD + update.length > maxMessageBytes) {
    const total = sent.reduce((sum, { len }) => sum + len, 0);
    if (total <= 1) break;
    sent = prefix(sent, Math.floor(total / 2));
    update = doc.export({ mode: "updates-in-range", spans: sent });
  }
  return { sent, update };
}

/** Advances what the server acked to the end of `sent`, a frame it just
 * acked; returns how many operations that frame held. */
export function markAcked(runtime: ChannelRuntime, sent: Span[]): number {
  let ops = 0;
  for (const { id, len } of sent) {
    ops += len;
    runtime.ackedOwn.setEnd({ peer: id.peer, counter: id.counter + len });
  }
  return ops;
}
