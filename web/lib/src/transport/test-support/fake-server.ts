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

interface StoredEntry {
  channel: string;
  seq: number;
  blob: Uint8Array;
}

interface Room {
  history: StoredEntry[];
  // Subscribers tracked per channel, not one set per document — mirrors
  // the real server's Room (docs/phase-3-second-canal-annotations.md §2):
  // a peer joined only to "content" must never be a publish target on
  // "annotations", and vice versa.
  subscribers: Map<string, Set<FakeSocket>>;
}

interface CompactRequest {
  documentId: string;
  channel: string;
  upToSeq: number;
  snapshot: Uint8Array;
}

/** A minimal in-memory stand-in for the real relay server (docs/phase-1
 * decision 2's wire protocol, extended per docs/phase-2-persistance-reprise.md
 * with a resume cursor and compaction, and per
 * docs/phase-3-second-canal-annotations.md with per-channel routing), used
 * to test the transport module's client logic without a real network —
 * matches "deux clients simulés, un faux serveur en mémoire" from
 * docs/phase-1-squelette-vertical.md step 5. */
export class FakeServer {
  private rooms = new Map<string, Room>();
  /** Every compaction request this server has received, for tests to
   * inspect (step 8: "un faux serveur qui enregistre le message de
   * compaction reçu et son contenu"). */
  readonly compactRequests: CompactRequest[] = [];
  /** Every join request this server has received, for tests to check
   * which channel/`since` cursor a client sent on reconnect (phase 2 step
   * 6, phase 3 decision 2: one shared cursor across channels). */
  readonly joinRequests: {
    documentId: string;
    channel: string;
    since: number | undefined;
  }[] = [];
  /** The close code an `auth` gets, or `undefined` to accept it: any
   * secret opens any document, unless a test says otherwise (the real
   * check is the server's, `server/auth`). */
  checkAuth: (
    documentId: string,
    role: Role,
    secret: Uint8Array,
  ) => number | undefined = () => undefined;
  /** The document's generation (ADR-0019 §6), bumped by a rotation. */
  private generations = new Map<string, number>();
  /** Verifiers of registered documents, base64url: their secrets are
   * checked for real. */
  private verifiers = new Map<string, Record<Role, string>>();
  /** Every close code this server sent, in order. */
  readonly closes: number[] = [];
  /** The server's wall clock, Unix seconds (ADR-0023 §2, R-D4). */
  now = 1_900_000_000;
  /** Each document's expiry, Unix seconds. */
  private expiries = new Map<string, number>();
  /** Documents deleted: nothing opens them any more (ADR-0023 §1). */
  private deleted = new Set<string>();
  /** When set, a deletion drops the requester's connection (1006) instead
   * of closing it with 4404: the reply lost on the way. */
  dropOnDelete = false;
  /** When set, a deletion is lost on the way: nothing happens. */
  loseDeletes = false;
  /** How many `auth` messages this server received. */
  authentications = 0;
  /** How many presence frames it relayed (ADR-0025). */
  presenceFrames = 0;
  /** The largest message it reads, like the real server's
   * `MAX_MESSAGE_BYTES`; beyond, it cuts the connection with no 44xx code
   * (docs/protocol/01-wire.md, W-40). */
  maxMessageBytes = Number.POSITIVE_INFINITY;
  private deliveryPaused = false;
  private heldDeliveries: (() => void)[] = [];

  /** The journal of `documentId`, all channels, in seq order. */
  entries(documentId: string): readonly StoredEntry[] {
    return this.rooms.get(documentId)?.history ?? [];
  }

  /** How many entries the journal of `documentId` holds, all channels. */
  journaled(documentId: string): number {
    return this.rooms.get(documentId)?.history.length ?? 0;
  }

  /** Journals `blob` as if published by a peer no longer connected — to
   * seed a document's history (the bench, the budgets). */
  append(documentId: string, channel: string, blob: Uint8Array): number {
    const room = this.roomFor(documentId);
    const seq = (room.history.at(-1)?.seq ?? 0) + 1;
    room.history.push({ channel, seq, blob });
    return seq;
  }

  connect(): SocketLike {
    return new FakeSocket(this);
  }

  /** Holds back delivery of any live push (to a peer other than the
   * publisher) until `resumeDelivery()` — the journal is still updated
   * synchronously either way. Used to simulate the exact race
   * docs/adr/0011-*.md describes: `tokio::select!` gives no ordering
   * guarantee between "flush a peer's pending push" and "handle that same
   * peer's own incoming publish and send its ack", so a peer can see its
   * own ack before an earlier-journaled op from someone else arrives. Acks
   * and history replies are never held back — only this. */
  pauseDelivery(): void {
    this.deliveryPaused = true;
  }

  resumeDelivery(): void {
    this.deliveryPaused = false;
    const held = this.heldDeliveries;
    this.heldDeliveries = [];
    for (const deliver of held) deliver();
  }

  deliverPush(target: FakeSocket, data: { data: ArrayBuffer }): void {
    if (this.deliveryPaused) {
      // Dies with its connection, like a real one still queued server-side.
      this.heldDeliveries.push(() => {
        if (!target.dead) target.onmessage?.(data);
      });
      return;
    }
    queueMicrotask(() => target.onmessage?.(data));
  }

  generation(documentId: string): number {
    return this.generations.get(documentId) ?? 1;
  }

  /** From now on, only the secrets of `verifiers` open `documentId`. */
  register(documentId: string, verifiers: Record<Role, string>): void {
    this.verifiers.set(documentId, verifiers);
  }

  /** Whether `secret` opens `documentId` as `role`. */
  admits(documentId: string, role: Role, secret: Uint8Array): boolean {
    if (this.deleted.has(documentId)) return false;
    const known = this.verifiers.get(documentId);
    return !known || known[role] === verifierSync(role, secret);
  }

  /** ADR-0019 §5: new verifiers, generation +1, every connection of the
   * document closed with 4410 — the requester after its reply. */
  rotate(
    documentId: string,
    verifiers: Record<Role, string>,
    requester: FakeSocket,
  ): number {
    this.verifiers.set(documentId, verifiers);
    const generation = this.generation(documentId) + 1;
    this.generations.set(documentId, generation);
    const room = this.rooms.get(documentId);
    const peers = new Set<FakeSocket>([requester]);
    for (const subscribers of room?.subscribers.values() ?? []) {
      for (const peer of subscribers) peers.add(peer);
    }
    for (const socket of this.authenticated) {
      if (socket.documentId === documentId) peers.add(socket);
    }
    requester.reply({ rotated: generation });
    for (const peer of peers) peer.refuse(CloseCode.Revoked);
    return generation;
  }

  /** The expiry of `documentId`, Unix seconds, or `null`. */
  expiry(documentId: string): number | null {
    return this.expiries.get(documentId) ?? null;
  }

  /** ADR-0023 §2: `inSeconds` from the server's now, or none; the reply
   * to the requester only. */
  setExpiry(
    documentId: string,
    inSeconds: number | null,
    requester: FakeSocket,
  ): void {
    if (inSeconds === null) this.expiries.delete(documentId);
    else this.expiries.set(documentId, this.now + inSeconds);
    requester.reply({ expiry: this.expiry(documentId) });
  }

  /** ADR-0023 §1: the document erased, every connection closed with 4404
   * (the requester's dropped instead, with `dropOnDelete`). */
  deleteDocument(documentId: string, requester: FakeSocket): void {
    if (this.loseDeletes) return;
    this.deleted.add(documentId);
    this.rooms.delete(documentId);
    this.expiries.delete(documentId);
    for (const socket of this.authenticated) {
      if (socket.documentId !== documentId || socket.dead) continue;
      if (socket === requester && this.dropOnDelete) {
        socket.dead = true;
        queueMicrotask(() => socket.onclose?.({ code: 1006 }));
      } else {
        socket.refuse(CloseCode.Deleted);
      }
    }
  }

  /** Connections authenticated, alive or not. */
  readonly authenticated = new Set<FakeSocket>();

  /** Simulates every currently connected socket dropping unexpectedly
   * (network failure), without going through the client's own `close()` —
   * used to test the transport module's reconnect behavior. */
  disconnectAll(): void {
    for (const room of this.rooms.values()) {
      const peers = new Set<FakeSocket>();
      for (const subscribers of room.subscribers.values()) {
        for (const peer of subscribers) peers.add(peer);
      }
      for (const subscribers of room.subscribers.values()) subscribers.clear();
      for (const peer of peers) {
        peer.dead = true;
        peer.onclose?.({ code: 1006 });
      }
    }
  }

  private roomFor(documentId: string): Room {
    let room = this.rooms.get(documentId);
    if (!room) {
      room = { history: [], subscribers: new Map() };
      this.rooms.set(documentId, room);
    }
    return room;
  }

  join(
    documentId: string,
    socket: FakeSocket,
    channel: string,
    since: number | undefined,
  ): StoredEntry[] {
    this.joinRequests.push({ documentId, channel, since });
    const room = this.roomFor(documentId);
    let subscribers = room.subscribers.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      room.subscribers.set(channel, subscribers);
    }
    subscribers.add(socket);
    const channelHistory = room.history.filter(
      (entry) => entry.channel === channel,
    );
    return since === undefined
      ? channelHistory
      : channelHistory.filter((entry) => entry.seq > since);
  }

  leave(documentId: string, socket: FakeSocket): void {
    const room = this.rooms.get(documentId);
    if (!room) return;
    for (const subscribers of room.subscribers.values()) {
      subscribers.delete(socket);
    }
  }

  publish(
    documentId: string,
    sender: FakeSocket,
    channel: string,
    blob: Uint8Array,
  ): { seq: number; targets: FakeSocket[] } {
    const room = this.roomFor(documentId);
    const seq = (room.history.at(-1)?.seq ?? 0) + 1;
    room.history.push({ channel, seq, blob });
    const subscribers = room.subscribers.get(channel);
    return {
      seq,
      targets: subscribers
        ? [...subscribers].filter((peer) => peer !== sender)
        : [],
    };
  }

  compact(
    documentId: string,
    channel: string,
    upToSeq: number,
    snapshot: Uint8Array,
  ): void {
    const room = this.roomFor(documentId);
    room.history = room.history.filter(
      (entry) => !(entry.channel === channel && entry.seq <= upToSeq),
    );
    room.history.push({ channel, seq: upToSeq, blob: snapshot });
    room.history.sort((a, b) => a.seq - b.seq);
    this.compactRequests.push({ documentId, channel, upToSeq, snapshot });
  }
}

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  /** A dropped or closed socket: like a real one, it silently swallows
   * anything sent afterwards — no journaling, no ack. */
  dead = false;
  documentId: string | null = null;
  private role: Role | undefined;

  constructor(private server: FakeServer) {
    queueMicrotask(() => this.onopen?.());
  }

  /** The server closes the connection with `code` (ADR-0019 §4):
   * nothing journaled nor acked for the message that caused it. */
  refuse(code: number): void {
    if (this.dead) return;
    this.server.closes.push(code);
    this.dead = true;
    if (this.documentId) this.server.leave(this.documentId, this);
    queueMicrotask(() => this.onclose?.({ code }));
  }

  reply(json: unknown): void {
    const data = JSON.stringify(json);
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  send(data: string | Uint8Array): void {
    if (this.dead) return;
    const size =
      typeof data === "string"
        ? new TextEncoder().encode(data).length
        : data.length;
    if (size > this.server.maxMessageBytes) {
      this.refuse(1009);
      return;
    }
    const { documentId, role } = this;
    if (typeof data === "string") {
      const parsed = JSON.parse(data) as
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

      if ("auth" in parsed) {
        this.server.authentications++;
        if (role === undefined && parsed.v !== PROTOCOL_VERSION) {
          this.refuse(CloseCode.UnsupportedVersion); // before the secret
          return;
        }
        const secret = base64UrlToBytes(parsed.secret);
        if (role !== undefined || !isRole(parsed.role)) {
          this.refuse(CloseCode.Unauthenticated);
          return;
        }
        const refusal = this.server.admits(parsed.auth, parsed.role, secret)
          ? this.server.checkAuth(parsed.auth, parsed.role, secret)
          : CloseCode.Unauthenticated;
        if (refusal !== undefined) {
          this.refuse(refusal);
          return;
        }
        this.server.authenticated.add(this);
        this.documentId = parsed.auth;
        this.role = parsed.role;
        this.reply({
          authenticated: parsed.role,
          generation: this.server.generation(parsed.auth),
          expires_at: this.server.expiry(parsed.auth),
          v: PROTOCOL_VERSION,
        });
        return;
      }
      if (!documentId || !role) {
        this.refuse(CloseCode.Unauthenticated);
        return;
      }

      if ("rotate" in parsed) {
        if (role !== "edit") {
          this.refuse(CloseCode.Forbidden);
          return;
        }
        this.server.rotate(documentId, parsed.rotate, this);
        return;
      }

      if ("delete" in parsed || "expire" in parsed) {
        const named = "delete" in parsed ? parsed.delete : parsed.expire;
        if (role !== "edit" || named !== documentId) {
          this.refuse(CloseCode.Forbidden);
          return;
        }
        if ("delete" in parsed) this.server.deleteDocument(documentId, this);
        else this.server.setExpiry(documentId, parsed.in, this);
        return;
      }

      if ("compact" in parsed) {
        if (!mayCompact(role) || parsed.compact !== documentId) {
          this.refuse(CloseCode.Forbidden);
          return;
        }
        this.server.compact(
          parsed.compact,
          parsed.channel,
          parsed.up_to_seq,
          base64ToBytes(parsed.snapshot),
        );
        return;
      }

      if (parsed.join !== documentId) {
        this.refuse(CloseCode.Forbidden);
        return;
      }
      const history = this.server.join(
        parsed.join,
        this,
        parsed.channel,
        parsed.since,
      );
      this.reply({
        history: history.map((entry) => ({
          channel: entry.channel,
          seq: entry.seq,
          blob: bytesToBase64(entry.blob),
        })),
      });
      return;
    }

    if (!documentId || !role) {
      this.refuse(CloseCode.Unauthenticated);
      return;
    }
    const frame = decodeFrame(data);
    if (!frame) {
      this.refuse(CloseCode.Malformed);
      return;
    }
    const { channel, blob } = frame;
    if (!mayPublish(role, channel)) {
      this.refuse(CloseCode.Forbidden);
      return;
    }
    if (channel === "presence") {
      // ADR-0025: to every other authenticated connection, never
      // journaled nor acked.
      this.server.presenceFrames++;
      const frameCopy = data.slice().buffer;
      for (const target of this.server.authenticated) {
        if (target === this || target.dead) continue;
        if (target.documentId !== documentId) continue;
        this.server.deliverPush(target, { data: frameCopy });
      }
      return;
    }
    const { seq, targets } = this.server.publish(
      documentId,
      this,
      channel,
      blob,
    );
    this.reply({ ack: channel, seq });
    const frameCopy = data.slice().buffer;
    for (const target of targets) {
      this.server.deliverPush(target, { data: frameCopy });
    }
  }

  close(): void {
    this.dead = true;
    if (this.documentId) this.server.leave(this.documentId, this);
    queueMicrotask(() => this.onclose?.({ code: 1005 }));
  }
}
