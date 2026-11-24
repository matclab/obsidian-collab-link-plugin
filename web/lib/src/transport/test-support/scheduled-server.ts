import {
  type Role,
  base64UrlToBytes,
  isRole,
} from "../../crypto/role-secrets.js";
import {
  type ChannelName,
  CloseCode,
  PROTOCOL_VERSION,
  decodeFrame,
  mayCompact,
  mayPublish,
} from "../protocol.js";
import type { SocketLike } from "../socket.js";
import { verifierSync } from "./verifiers.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface JournalEntry {
  channel: string;
  seq: number;
  blob: Uint8Array;
}

type Outgoing =
  | { data: string | ArrayBuffer }
  | "open"
  | { close: number }
  /** An ack of no frame (G1), its channel fixed when delivered. */
  | { strayAck: number };

/** A server whose deliveries the test schedules, one message at a time —
 * for property tests of the transport (ADR-0015). It behaves like the real
 * one (`server/transport`): journal before broadcast, one shared seq
 * across channels, an ack to the publisher only, a compaction refused
 * beyond what a join confirmed to that connection (ADR-0011). What it
 * adds is control over the one ordering the real server doesn't
 * guarantee: each connection has two queues, `replies` (history replies
 * and acks, sent inline by the connection's loop) and `pushes` (frames of
 * other peers, through its mpsc channel), and `tokio::select!` may send
 * either head first. Messages from a client are handled as they are sent,
 * in order.
 *
 * Access (ADR-0019): authentication first, the rights table, and — once
 * `verifiers` is set — real secret checks, so that a replaced link is
 * refused (R-B4). A rotation answers the requester in its `replies`, and
 * closes every other connection through its `pushes`, as the real server
 * does through each connection's mpsc; a message such a connection sends
 * before it learns so is refused by the generation check (R-B2). */
export class ScheduledServer {
  readonly journal: JournalEntry[] = [];
  readonly sockets: ScheduledSocket[] = [];
  /** Every close code this server sent, in order. */
  readonly closes: number[] = [];
  /** The document's generation (ADR-0019 §6), bumped by a rotation. */
  generation = 1;
  /** When set, the close code every `auth` gets instead of a reply. */
  authRefusal: number | undefined;
  /** The document's verifiers, base64url; unset, any secret opens it. */
  verifiers: Record<Role, string> | undefined;
  /** The largest message it reads, like the real server's
   * `MAX_MESSAGE_BYTES`; beyond, it cuts the connection with no 44xx code
   * (docs/protocol/01-wire.md, W-40). */
  maxMessageBytes = Number.POSITIVE_INFINITY;
  /** The server's wall clock, Unix seconds (ADR-0023 §2). */
  readonly now = 1_900_000_000;
  /** The document's expiry, Unix seconds, or `null`. */
  expiresAt: number | null = null;
  /** The connection whose deletion passed (ADR-0023 §1): from then on,
   * nothing opens the document and every message is refused with 4404. */
  deletedBy: ScheduledSocket | undefined;
  /** Every presence frame relayed, and its sender's role (ADR-0025). */
  readonly presence: { from: ScheduledSocket; role: Role }[] = [];
  private nextSeq = 1;

  connect(): SocketLike {
    const socket = new ScheduledSocket(this);
    this.sockets.push(socket);
    return socket;
  }

  /** Connections a message can be delivered on, with what they hold. */
  deliverable(): ScheduledSocket[] {
    return this.sockets.filter(
      (socket) =>
        !socket.dead && (socket.replies.length > 0 || socket.pushes.length > 0),
    );
  }

  join(socket: ScheduledSocket, channel: string, since?: number): void {
    socket.channels.add(channel);
    const entries = this.journal.filter(
      (entry) =>
        entry.channel === channel && (since === undefined || entry.seq > since),
    );
    const last = entries.at(-1);
    if (last) {
      socket.confirmed.set(
        channel,
        Math.max(socket.confirmed.get(channel) ?? 0, last.seq),
      );
    }
    socket.replies.push({
      data: JSON.stringify({
        history: entries.map((entry) => ({
          channel: entry.channel,
          seq: entry.seq,
          blob: bytesToBase64(entry.blob),
        })),
      }),
    });
  }

  /** Accepts any secret (the real check is the server's): the role is
   * what the test is about. */
  authenticate(socket: ScheduledSocket, role: Role, secret: string): void {
    if (this.authRefusal !== undefined) {
      this.refuse(socket, this.authRefusal);
      return;
    }
    if (this.deletedBy) {
      this.refuse(socket, CloseCode.Unauthenticated); // unknown document
      return;
    }
    if (
      this.verifiers &&
      this.verifiers[role] !== verifierSync(role, base64UrlToBytes(secret))
    ) {
      this.refuse(socket, CloseCode.Unauthenticated);
      return;
    }
    socket.role = role;
    socket.generation = this.generation;
    socket.replies.push({
      data: JSON.stringify({
        authenticated: role,
        generation: this.generation,
        expires_at: this.expiresAt,
        v: PROTOCOL_VERSION,
      }),
    });
  }

  /** Closes `socket` with `code` once what it already queued is sent,
   * like the real server's loop: it stops reading, nothing more is
   * journaled for it. */
  refuse(socket: ScheduledSocket, code: number): void {
    if (socket.refused !== undefined) return;
    socket.refused = code;
    this.closes.push(code);
    socket.replies.push({ close: code });
  }

  /** ADR-0019 §5. */
  rotate(socket: ScheduledSocket, verifiers: Record<Role, string>): void {
    if (socket.role !== "edit") {
      this.refuse(socket, CloseCode.Forbidden);
      return;
    }
    this.verifiers = verifiers;
    this.generation++;
    for (const peer of this.sockets) {
      if (peer === socket || peer.dead || peer.role === undefined) continue;
      if (peer.refused !== undefined || peer.revoked) continue;
      peer.revoked = true;
      this.closes.push(CloseCode.Revoked);
      peer.pushes.push({ close: CloseCode.Revoked });
    }
    socket.replies.push({
      data: JSON.stringify({ rotated: this.generation }),
    });
    this.refuse(socket, CloseCode.Revoked);
  }

  /** ADR-0023 §2: the reply to the requester only. */
  expire(socket: ScheduledSocket, inSeconds: number | null): void {
    if (socket.role !== "edit") {
      this.refuse(socket, CloseCode.Forbidden);
      return;
    }
    this.expiresAt = inSeconds === null ? null : this.now + inSeconds;
    socket.replies.push({
      data: JSON.stringify({ expiry: this.expiresAt }),
    });
  }

  /** ADR-0023 §1: every other connection closed through its `pushes`,
   * like a rotation; the requester's close is its only answer. */
  deleteDocument(socket: ScheduledSocket): void {
    if (socket.role !== "edit") {
      this.refuse(socket, CloseCode.Forbidden);
      return;
    }
    this.deletedBy = socket;
    for (const peer of this.sockets) {
      if (peer === socket || peer.dead || peer.role === undefined) continue;
      if (peer.refused !== undefined || peer.revoked) continue;
      peer.revoked = true;
      this.closes.push(CloseCode.Deleted);
      peer.pushes.push({ close: CloseCode.Deleted });
    }
    this.refuse(socket, CloseCode.Deleted);
  }

  /** Whether `socket` authenticated before the last rotation. */
  stale(socket: ScheduledSocket): boolean {
    return socket.role !== undefined && socket.generation !== this.generation;
  }

  publish(socket: ScheduledSocket, frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (!decoded) {
      this.refuse(socket, CloseCode.Malformed);
      return;
    }
    const { channel, blob } = decoded;
    if (!socket.role || !mayPublish(socket.role, channel)) {
      this.refuse(socket, CloseCode.Forbidden);
      return;
    }
    if (channel === "presence") {
      // ADR-0025: to every other authenticated connection of the current
      // links, through its pushes; never journaled, never acked.
      this.presence.push({ from: socket, role: socket.role });
      for (const peer of this.sockets) {
        if (peer === socket || peer.dead || peer.role === undefined) continue;
        if (this.stale(peer) || peer.refused !== undefined) continue;
        peer.pushes.push({ data: frame.slice().buffer });
      }
      return;
    }
    const seq = this.nextSeq++;
    this.journal.push({ channel, seq, blob });
    socket.replies.push({ data: JSON.stringify({ ack: channel, seq }) });
    for (const peer of this.sockets) {
      if (
        peer !== socket &&
        !peer.dead &&
        !this.stale(peer) &&
        peer.channels.has(channel)
      ) {
        peer.pushes.push({ data: frame.slice().buffer });
      }
    }
  }

  compact(
    socket: ScheduledSocket,
    channel: string,
    upToSeq: number,
    snapshot: Uint8Array,
  ): void {
    if (!socket.role || !mayCompact(socket.role)) {
      this.refuse(socket, CloseCode.Forbidden);
      return;
    }
    if (upToSeq === 0 || upToSeq > (socket.confirmed.get(channel) ?? 0)) {
      return; // refused silently, like the real server
    }
    const kept = this.journal.filter(
      (entry) => !(entry.channel === channel && entry.seq <= upToSeq),
    );
    kept.push({ channel, seq: upToSeq, blob: snapshot });
    kept.sort((a, b) => a.seq - b.seq);
    this.journal.splice(0, this.journal.length, ...kept);
  }
}

export class ScheduledSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly replies: Outgoing[] = ["open"];
  readonly pushes: Outgoing[] = [];
  readonly channels = new Set<string>();
  /** Highest seq a join replayed to this connection, per channel. */
  readonly confirmed = new Map<string, number>();
  dead = false;
  /** Channels the client sent a frame on, refused or not. */
  readonly sentOn = new Set<string>();
  role: Role | undefined;
  generation = 0;
  /** The code the server closes this connection with, once it has. */
  refused: number | undefined;
  /** A rotation or a deletion queued its close in `pushes`. */
  revoked = false;
  /** The protocol version its `auth` carried. */
  version: unknown;
  private open = false;

  constructor(private readonly server: ScheduledServer) {}

  /** Delivers the head of one queue. */
  deliver(queue: "replies" | "pushes"): void {
    const message = this[queue].shift();
    if (!message || this.dead) return;
    if (message === "open") {
      this.open = true;
      this.onopen?.();
      return;
    }
    if ("close" in message) {
      this.closeWith(message.close);
      return;
    }
    if ("strayAck" in message) {
      this.onmessage?.({ data: this.strayAck(message.strayAck) });
      return;
    }
    this.onmessage?.(message);
  }

  /** An ack the client can tell is stray (G1), fixed at delivery: of a
   * channel this connection never sent a frame on — it can't be the ack
   * of the client's oldest frame awaiting one —, or, if it sent on every
   * channel, unreadable. One of the right channel would be taken for the
   * ack of that frame, whether the server journaled it or not: no client
   * can tell, and a server that acks what it didn't journal loses data. */
  private strayAck(seq: number): string {
    const unused = ["content", "annotations", "decisions"].find(
      (channel) => !this.sentOn.has(channel),
    );
    return JSON.stringify(
      unused ? { ack: unused, seq } : { ack: "content", seq: String(seq) },
    );
  }

  /** The connection drops: whatever is still queued is lost. */
  drop(): void {
    this.closeWith(1006);
  }

  private closeWith(code: number): void {
    if (this.dead) return;
    this.dead = true;
    this.replies.length = 0;
    this.pushes.length = 0;
    this.onclose?.({ code });
  }

  send(data: string | Uint8Array): void {
    if (!this.open && !this.dead) {
      throw new Error("InvalidStateError: still connecting"); // like a WebSocket
    }
    if (typeof data !== "string" && data[0] !== undefined) {
      this.sentOn.add(
        ["content", "annotations", "decisions", "presence"][data[0]] ?? "",
      );
    }
    if (this.dead || this.refused !== undefined) return; // silently lost
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).length
        : data.length;
    if (size > this.server.maxMessageBytes) {
      this.server.refuse(this, 1009);
      return;
    }
    const authenticated = this.role !== undefined;
    if (authenticated && this.server.deletedBy) {
      this.server.refuse(this, CloseCode.Deleted); // R-D1, before R-B2
      return;
    }
    if (this.server.stale(this)) {
      this.server.refuse(this, CloseCode.Revoked); // R-B2
      return;
    }
    if (typeof data !== "string") {
      if (!authenticated) {
        this.server.refuse(this, CloseCode.Unauthenticated);
      } else {
        this.server.publish(this, data);
      }
      return;
    }
    const message = JSON.parse(data) as
      | { auth: string; v?: unknown; role: string; secret: string }
      | { rotate: Record<Role, string> }
      | { delete: string }
      | { expire: string; in: number | null }
      | { join: string; channel: ChannelName; since?: number }
      | {
          compact: string;
          channel: ChannelName;
          up_to_seq: number;
          snapshot: string;
        };
    if ("auth" in message) {
      if (!authenticated) this.version = message.v;
      if (!authenticated && message.v !== PROTOCOL_VERSION) {
        this.server.refuse(this, CloseCode.UnsupportedVersion);
      } else if (authenticated || !isRole(message.role)) {
        this.server.refuse(this, CloseCode.Unauthenticated);
      } else {
        this.server.authenticate(this, message.role, message.secret);
      }
    } else if (!authenticated) {
      this.server.refuse(this, CloseCode.Unauthenticated);
    } else if ("rotate" in message) {
      this.server.rotate(this, message.rotate);
    } else if ("delete" in message) {
      this.server.deleteDocument(this);
    } else if ("expire" in message) {
      this.server.expire(this, message.in);
    } else if ("join" in message) {
      this.server.join(this, message.channel, message.since);
    } else {
      this.server.compact(
        this,
        message.channel,
        message.up_to_seq,
        base64ToBytes(message.snapshot),
      );
    }
  }

  close(code = 1005): void {
    this.closeWith(code);
  }
}
