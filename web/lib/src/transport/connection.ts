import type { LoroDoc } from "loro-crdt";
import type { Role } from "../crypto/role-secrets.js";
import type { ChannelState } from "./channel-state.js";
import type { ConfirmedRecord } from "./history-reply.js";
import type { ChannelName } from "./protocol.js";
import type { SocketFactory } from "./socket.js";

// What `connectDocument` (client.ts) takes and gives: the connection's
// contract, apart from how it is kept.

export interface DocumentConnection {
  close(): void;
  /** Renews every link of the document (ADR-0019 §5): sends the
   * verifiers of the three secrets derived from `next.secret`. The caller
   * keeps `next.secret` durably first (R-B4). Resolves once the server
   * confirms; every connection of the document is then cut, and this one
   * comes back with the new secret (`onRenewed`). Rejects if the
   * connection drops before the reply: the outcome is unknown, and the
   * next connection finds it out (`pendingEditSecret`). */
  rotate(next: {
    secret: Uint8Array;
    verifiers: Record<Role, Uint8Array>;
  }): Promise<void>;
  /** Erases the document from the server (ADR-0023 §1). No reply: every
   * connection closes with `4404`, this one too (`onRefused`). If this one
   * drops first, its reconnection gets `4401`, reported as it is: it
   * can't be told from links renewed meanwhile (ADR-0024). Nothing more
   * is sent on this connection. Throws, sending nothing, unless an
   * editor's connection is up. */
  deleteDocument(): void;
  /** Sets the document's expiry `inSeconds` from the server's now, or
   * removes it (`null`) (ADR-0023 §2). Resolves with the expiry the
   * server recorded (Unix seconds, or `null`), also given to `onExpiry`.
   * Rejects, sending nothing, unless an editor's connection is up and no
   * other expiry is in flight; rejects if the connection drops before
   * the reply (the next authentication tells the outcome). */
  setExpiry(inSeconds: number | null): Promise<number | null>;
  /** Sends `state` on `presence`, encrypted (ADR-0025): relayed to the
   * others, never journaled nor acked. Dropped when the connection isn't
   * up, or for a reader; `presence.connected` says when to send again. */
  publishPresence(state: Uint8Array): void;
  /** Publishes `change`, a change this client imported and adopts (an
   * accepted suggestion, ADR-0018): it isn't its own operations, so
   * nothing else ever sends it (ADR-0015). Alone in its frame, before any
   * operation of its own not yet sent (R-A1), until acked (R-A2). Call it
   * in the same turn as the import. Ignored where the role may not
   * publish. */
  adopt(channel: ChannelConnection["channel"], change: Uint8Array): void;
  /** Publishes one decisions record (already serialized, not yet
   * encrypted). Queued while offline and retried until acked, so the
   * server may journal it more than once — harmless for the first-wins
   * rule, a copy is always journaled after the original
   * (docs/adr/0013-*.md). */
  publishDecision(record: Uint8Array): void;
  /** What a later page needs to resume this connection (ADR-0022), read
   * in this very turn: capture it with the docs' snapshots, in the same
   * turn, and they agree (phase 7, L2). */
  persisted(): TransportState;
  /** The counter up to which the server acked the operations of `peer`,
   * one of this client's, on `channel` (0: none yet): an operation of
   * counter `c` is published once this is past `c` (O-41). */
  acknowledged(channel: ChannelConnection["channel"], peer: string): number;
}

export interface TransportState {
  channels: ChannelState[];
  /** The decisions cursor, and the records sent but not acked. */
  decisions: { cursor: number; outbox: Uint8Array[] };
}

/** The decisions channel: a record log, not a CRDT (docs/adr/0013-*.md).
 * `onConfirmed` receives batches whose union is always a gapless prefix of
 * the channel's journal: each batch is sorted by seq, never repeats a seq
 * already delivered, and never skips one. Pushed frames and acks are never
 * delivered — they only trigger a rejoin (docs/adr/0011-*.md). */
export interface DecisionsConnection {
  onConfirmed(batch: ConfirmedRecord[]): void;
}

/** One channel this connection follows: its own `LoroDoc`, independent of
 * every other channel on the same connection
 * (`docs/phase-3-second-canal-annotations.md` decision 6) — a change on one
 * channel's doc must never be observable on another's. */
export interface ChannelConnection {
  channel: Exclude<ChannelName, "decisions">;
  doc: LoroDoc;
}

export interface ConnectOptions {
  url: string;
  documentId: string;
  key: CryptoKey;
  /** The role and secret of the link (ADR-0019): sent first on every
   * connection; the client publishes only where the role may. */
  credentials: { role: Role; secret: Uint8Array };
  /** Called when the server closes the connection for good after it was
   * up (before, `connectDocument` rejects with `ConnectionRefused`). */
  onRefused?: (code: number) => void;
  /** An edit secret this client sent in a rotation whose outcome it
   * doesn't know (R-B4): tried when the link's own secret is refused
   * (`4401`, `4410`). */
  pendingEditSecret?: Uint8Array;
  /** Presence (ADR-0025): `receive` gets each state another page sent,
   * decrypted; `connected` is called after each authentication (R-P6). */
  presence?: {
    receive(state: Uint8Array): void;
    connected(): void;
  };
  /** The document's expiry (Unix seconds, or `null`: none), at each
   * authentication and in the reply to this client's `setExpiry` — not
   * when another editor changes it (ADR-0023 §2). */
  onExpiry?: (expiresAt: number | null) => void;
  /** Called on the first authentication with a new edit secret, whether
   * from `rotate` or `pendingEditSecret`: the link has changed. */
  onRenewed?: (editSecret: Uint8Array) => void;
  /** Gets the connection as soon as it exists, before the first history
   * reply: what the page does meanwhile (adopting a change imported from
   * that history) reaches it in order (R-A1). */
  onConnection?: (connection: DocumentConnection) => void;
  /** One entry per channel to join on this connection (e.g. content,
   * annotations) — replaces the single `doc`/`textName` pair from phase 2
   * now that a connection can follow more than one channel. Publish,
   * subscribe, reconnect and compaction all loop over this list rather
   * than duplicating the whole module per channel (decision 6; the
   * rejected alternative — a second copy of this file for annotations —
   * would violate AGENTS.md §1.2's one-reason-to-change rule the moment a
   * reconnect bug needed fixing twice). */
  channels: ChannelConnection[];
  /** Called for each entry skipped because it doesn't decrypt or isn't a
   * Loro update (docs/phase-5-modele-acces.md, decision 10): the rest is
   * imported, and the cursor moves past it (it will never become valid). */
  onInvalidEntry?: (channel: ChannelName) => void;
  /** A Loro panic poisoned a document (docs/phase-9-durcissement.md, L4): the
   * client has stopped for good. */
  onFatal?: (error: unknown) => void;
  /** Called with the Loro updates of every import, right before it —
   * one push, or a whole history reply — for scenario traces (`trace/`). */
  onImport?: (
    channel: ChannelConnection["channel"],
    updates: Uint8Array[],
  ) => void;
  /** What an earlier page stored (`persisted`, ADR-0022): each channel
   * rejoins from its cursor and publishes what the server hadn't acked —
   * the stored peers' operations, which the docs must already hold (their
   * stored snapshots), and the adopted changes, first. The docs keep their
   * own fresh peer id (R-L1). */
  resume?: TransportState;
  /** Called when the server acks a frame of this client, once what
   * `persisted` reports as not yet sent has shrunk (ADR-0022). */
  onAcked?: () => void;
  /** Follow the decisions channel too (omitted: not joined at all). */
  decisions?: DecisionsConnection;
  socketFactory?: SocketFactory;
  /** Ops published by a client on a given channel since that channel's
   * last compaction, before triggering another one
   * (`docs/phase-2-persistance-reprise.md` decision 6, extended per
   * `docs/phase-3-second-canal-annotations.md` decision 5 to be tracked
   * per channel rather than once for the whole connection — channels
   * accumulate ops at very different rates). Overridable mainly so tests
   * don't need thousands of ops. */
  compactionThreshold?: number;
  /** Least time between two frames on one Loro channel: commits made in
   * the meantime leave together (ADR-0015). */
  publishIntervalMs?: number;
  /** Wait before reconnecting after a drop (tests shorten it). */
  reconnectDelayMs?: number;
  /** The server's message size limit (tests shorten it). */
  maxMessageBytes?: number;
  /** Told when this connection starts and ends work of its own — a timer,
   * an encryption, a decryption — as opposed to waiting for the server.
   * For tests that schedule deliveries: they wait until nothing is at
   * work, instead of a number of turns that a busy machine outlasts. */
  activity?: Activity;
}

export interface Activity {
  begin(): void;
  end(): void;
}
