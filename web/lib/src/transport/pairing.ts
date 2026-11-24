import type { ChannelName } from "./protocol.js";

/** FIFO of publishes awaiting their ack, so `trySend` can tell a genuine
 * server confirmation apart from `socket.send()` merely not throwing —
 * which happens even when the underlying connection is silently dying
 * (e.g. a real network drop): the write can look locally successful while
 * never reaching the server. A single queue shared across every channel:
 * all publishes share one WebSocket connection, and the server acks them
 * strictly in the order it received them regardless of which channel each
 * belongs to (it processes one incoming message at a time per connection),
 * so position-based FIFO matching stays correct even with several channels
 * interleaved. Resolved in order as acks arrive; flushed with `undefined`
 * ("not confirmed") on disconnect so a `trySend` in flight during a drop
 * fails cleanly instead of hanging, letting the edit be retried by
 * `publishPending()` after the next history reply. */
export class AckQueue {
  private waiting: {
    channel: ChannelName;
    resolve: (seq: number | undefined) => void;
  }[] = [];

  push(channel: ChannelName, resolve: (seq: number | undefined) => void) {
    this.waiting.push({ channel, resolve });
  }

  /** `false`: no frame of that channel is the next one awaiting its ack
   * — the server doesn't pair as this client does. */
  resolveNext(channel: ChannelName, seq: number): boolean {
    if (this.waiting[0]?.channel !== channel) return false;
    this.waiting.shift()?.resolve(seq);
    return true;
  }

  failAll(): void {
    for (const { resolve } of this.waiting) resolve(undefined);
    this.waiting = [];
  }
}

export interface PendingJoin {
  channel: ChannelName;
  onReplied: (maxSeqInReply: number | undefined) => void;
}

/** Every JoinMessage sent on the current connection whose HistoryReply
 * hasn't arrived yet, in the exact order they were sent — the server
 * processes messages on one connection strictly in receipt order and
 * replies to each join before handling the next incoming message, so
 * replies arrive in this same order
 * (`docs/phase-3-second-canal-annotations.md` decision 4). Position-based
 * correlation, rather than trusting reply content alone, is what lets an
 * *empty* history reply (which carries no channel of its own — only
 * non-empty entries do) still be attributed to the right channel. Shared by
 * a connection's initial per-channel joins and the on-demand rejoins of
 * compaction and decisions, since all send JoinMessages on the same
 * connection and must be correlated against the one true send order. */
export class JoinQueue {
  private joins: PendingJoin[] = [];

  /** A new connection: the joins of the old one will never be replied. */
  reset(joins: PendingJoin[]): void {
    this.joins = joins;
  }

  push(join: PendingJoin): void {
    this.joins.push(join);
  }

  shift(): PendingJoin | undefined {
    return this.joins.shift();
  }
}
