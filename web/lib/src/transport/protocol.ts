import { type Role, bytesToBase64Url, isRole } from "../crypto/role-secrets.js";

/** `content` and `annotations` carry Loro updates; `decisions` carries one
 * encrypted proposal record per frame, not a CRDT (docs/adr/0013-*.md). */
export type ChannelName = "content" | "annotations" | "decisions";

/** The channels a binary frame can carry: the journaled ones, and
 * `presence`, only relayed (ADR-0025) — never in a history reply nor an
 * ack. */
export type FrameChannel = ChannelName | "presence";

const CHANNEL_BYTES: Record<FrameChannel, number> = {
  content: 0,
  annotations: 1,
  decisions: 2,
  presence: 3,
};
const BYTES_TO_CHANNEL: Record<number, FrameChannel> = {
  0: "content",
  1: "annotations",
  2: "decisions",
  3: "presence",
};

/** Who may publish where (ADR-0019 §1, ADR-0025 §3, mirrors
 * `channels::may_publish`): the server closes the connection with `4403`
 * otherwise. A reader publishes nothing, not even its presence. */
export function mayPublish(role: Role, channel: FrameChannel): boolean {
  if (role === "edit") return true;
  return (
    role === "suggest" && (channel === "annotations" || channel === "presence")
  );
}

/** Compacting erases what others wrote: editors only. */
export function mayCompact(role: Role): boolean {
  return role === "edit";
}

/** Deleting the document, and setting its expiry: editors only
 * (ADR-0023 §3). */
export function mayDelete(role: Role): boolean {
  return role === "edit";
}

/** The protocol version this client speaks, sent in `auth` and in the
 * creation request, and echoed by `authenticated`
 * (docs/phase-8-protocole-ouvert.md, N1-N3). */
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes the server uses (ADR-0019 §4, ADR-0020). */
export const CloseCode = {
  /** Unreadable message. */
  Malformed: 4400,
  /** Wrong secret, unknown or replaced link, deadline passed. */
  Unauthenticated: 4401,
  /** An act the role doesn't allow, or another document. */
  Forbidden: 4403,
  /** The document's links were renewed. */
  Revoked: 4410,
  /** Too slow a connection: its send queue overflowed. */
  TooSlow: 4408,
  /** The document's connection cap is reached. */
  TooManyConnections: 4429,
  /** The document was deleted, by an editor or at its expiry (ADR-0023). */
  Deleted: 4404,
  /** The server doesn't speak this client's protocol version: one of them
   * was updated (docs/phase-8-protocole-ouvert.md, N1). */
  UnsupportedVersion: 4426,
} as const;

/** The first message of a connection: the role secret itself, which TLS
 * protects in transit (ADR-0019 §3). */
export function encodeAuthMessage(
  documentId: string,
  role: Role,
  secret: Uint8Array,
): string {
  return JSON.stringify({
    auth: documentId,
    v: PROTOCOL_VERSION,
    role,
    secret: bytesToBase64Url(secret),
  });
}

/** Renews every link of the document: the verifiers of the three new
 * secrets (ADR-0019 §5). */
export function encodeRotateMessage(
  verifiers: Record<Role, Uint8Array>,
): string {
  return JSON.stringify({
    rotate: {
      read: bytesToBase64Url(verifiers.read),
      suggest: bytesToBase64Url(verifiers.suggest),
      edit: bytesToBase64Url(verifiers.edit),
    },
  });
}

/** Erases the document from the server (ADR-0023 §1): no reply, the
 * close `4404` confirms it. */
export function encodeDeleteMessage(documentId: string): string {
  return JSON.stringify({ delete: documentId });
}

/** The longest expiry the server accepts: a hundred years, in seconds
 * (mirrors `channels::MAX_EXPIRY_SECONDS`, ADR-0023 §2). */
export const MAX_EXPIRY_SECONDS = 100 * 365 * 24 * 60 * 60;

/** Sets the document's expiry `inSeconds` from the server's own now, or
 * removes it (`null`) (ADR-0023 §2, R-D4). */
export function encodeExpireMessage(
  documentId: string,
  inSeconds: number | null,
): string {
  return JSON.stringify({ expire: documentId, in: inSeconds });
}

/** The largest WebSocket message the server accepts (mirrors
 * `channels::MAX_MESSAGE_BYTES`); it closes the connection on a larger one.
 * The largest legitimate message is a compaction, its full snapshot in
 * base64 (ADR-0017). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** What a frame adds to its plaintext: the channel byte, the nonce and
 * the authentication tag (docs/protocol/02-links-and-encryption.md, K-10). */
export const FRAME_OVERHEAD = 1 + 12 + 16;

/** `since` is the last seq this client already has
 * (docs/phase-2-persistance-reprise.md step 4) — omitted means "replay
 * everything", phase 1's behavior. */
export function encodeJoinMessage(
  documentId: string,
  channel: ChannelName,
  since?: number,
): string {
  return JSON.stringify(
    since === undefined
      ? { join: documentId, channel }
      : { join: documentId, channel, since },
  );
}

export function encodeFrame(
  channel: FrameChannel,
  blob: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(1 + blob.length);
  frame[0] = CHANNEL_BYTES[channel];
  frame.set(blob, 1);
  return frame;
}

/** `undefined` for a channel this client doesn't know: a later extension
 * of the server may push one, the client ignores it
 * (docs/phase-8-protocole-ouvert.md). */
export function decodeFrame(
  frame: Uint8Array,
): { channel: FrameChannel; blob: Uint8Array } | undefined {
  const channelByte = frame[0];
  if (channelByte === undefined) {
    throw new Error("frame is empty, missing the channel-id byte");
  }
  const channel = BYTES_TO_CHANNEL[channelByte];
  if (channel === undefined) return undefined;
  return { channel, blob: frame.slice(1) };
}

/** Standard base64 with its padding (W-1), or `undefined`: `atob` alone
 * would also take a missing padding and whitespace. */
function base64ToBytes(base64: string): Uint8Array | undefined {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return undefined;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The server is a trust boundary (docs/adr/0002-*.md's threat model aside,
// its JSON is still external input this client didn't produce) — these
// helpers narrow `unknown` before any field is used, the same "throw on a
// malformed shape" contract `decodeFrame` above already has for the binary
// side, rather than trusting a bare `as` cast on parsed JSON.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A `seq`, a generation or a Unix time (W-2). */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isChannelName(value: unknown): value is ChannelName {
  return (
    value === "content" || value === "annotations" || value === "decisions"
  );
}

/** One entry of a history reply: `seq` lets the client track its own
 * resume cursor (docs/phase-2-persistance-reprise.md step 4). */
export interface HistoryEntry {
  channel: ChannelName;
  seq: number;
  blob: Uint8Array;
}

/** `undefined` for an entry of a channel this client doesn't know —
 * whatever its `channel` holds, absent or not a string included (W-46): it
 * never joined one, it skips it. */
function parseHistoryEntry(raw: unknown): HistoryEntry | undefined {
  const record = asRecord(raw);
  if (!record) {
    throw new Error(`malformed history entry: ${JSON.stringify(raw)}`);
  }
  if (!isChannelName(record.channel)) return undefined;
  const blob =
    typeof record.blob === "string" ? base64ToBytes(record.blob) : undefined;
  if (!isCount(record.seq) || !blob) {
    throw new Error(`malformed history entry: ${JSON.stringify(raw)}`);
  }
  return { channel: record.channel, seq: record.seq, blob };
}

export function decodeHistoryReply(json: string): HistoryEntry[] {
  const parsed = asRecord(JSON.parse(json));
  if (!parsed || !Array.isArray(parsed.history)) {
    throw new Error(`malformed history reply: ${json}`);
  }
  return parsed.history.flatMap((raw) => parseHistoryEntry(raw) ?? []);
}

/** The control message requesting compaction of a channel's journal up to
 * `upToSeq`, replacing everything up to that point with `snapshot` — the
 * server never interprets `snapshot` beyond routing it to storage
 * (docs/phase-2-persistance-reprise.md step 4). */
export function encodeCompactMessage(
  documentId: string,
  channel: ChannelName,
  upToSeq: number,
  snapshot: Uint8Array,
): string {
  return JSON.stringify({
    compact: documentId,
    channel,
    up_to_seq: upToSeq,
    snapshot: bytesToBase64(snapshot),
  });
}

/** Sent by the server only to the publisher, right after a binary publish
 * is durably journaled — never broadcast. Lets the sender learn the seq
 * its own op was assigned, which it otherwise has no way to know (needed
 * to pick a valid `up_to_seq` when deciding to compact,
 * docs/phase-2-persistance-reprise.md step 8). */
export interface PublishAck {
  channel: ChannelName;
  seq: number;
}

/** On the wire, `{"ack": <channel>, "seq": <seq>}`. */
export function decodePublishAck(json: string): PublishAck {
  const record = asRecord(JSON.parse(json));
  if (!record || !isChannelName(record.ack) || !isCount(record.seq)) {
    throw new Error(`malformed publish ack: ${json}`);
  }
  return { channel: record.ack, seq: record.seq };
}

/** A text message from the server. */
export type ServerText =
  | { kind: "history"; entries: HistoryEntry[] }
  | ({ kind: "ack" } & PublishAck)
  | {
      kind: "authenticated";
      role: Role;
      generation: number;
      /** Unix seconds, or `null`: none (ADR-0023 §2). */
      expiresAt: number | null;
      /** The protocol version the server holds this connection to. */
      version: number;
    }
  | { kind: "rotated"; generation: number }
  /** The reply to this editor's `expire`. */
  | { kind: "expiry"; expiresAt: number | null }
  /** Something a later extension of the server sends: ignored. */
  | { kind: "unknown" };

/** The key of each server message, which no other message carries
 * (docs/phase-8-protocole-ouvert.md, N4): a message is recognized by it
 * alone, never by elimination. */
const SERVER_MESSAGE_KEYS = [
  "history",
  "authenticated",
  "rotated",
  "expiry",
  "ack",
] as const;

/** An expiry field: Unix seconds or `null` (W-8, W-26); absent, or any
 * other value, is malformed (W-47). */
function expiryOf(value: unknown, json: string): number | null {
  if (value === null) return null;
  if (!isCount(value)) throw new Error(`malformed expiry: ${json}`);
  return value;
}

/** Unknown fields are ignored, and so is a message under a key this
 * client doesn't know; a known message of the wrong shape throws. */
export function decodeServerText(json: string): ServerText {
  const record = asRecord(JSON.parse(json));
  if (!record) throw new Error(`malformed server message: ${json}`);
  const keys = SERVER_MESSAGE_KEYS.filter((key) => key in record);
  if (keys.length === 0) return { kind: "unknown" };
  if (keys.length > 1) throw new Error(`ambiguous server message: ${json}`);
  if ("history" in record) {
    return { kind: "history", entries: decodeHistoryReply(json) };
  }
  if ("authenticated" in record) {
    if (
      !isRole(record.authenticated) ||
      !isCount(record.generation) ||
      // Any other integer is another version (W-9); not an integer, the
      // wrong form.
      !Number.isSafeInteger(record.v)
    ) {
      throw new Error(`malformed authentication reply: ${json}`);
    }
    return {
      kind: "authenticated",
      role: record.authenticated,
      generation: record.generation,
      expiresAt: expiryOf(record.expires_at, json),
      version: record.v as number,
    };
  }
  if ("expiry" in record) {
    return { kind: "expiry", expiresAt: expiryOf(record.expiry, json) };
  }
  if ("rotated" in record) {
    if (!isCount(record.rotated)) {
      throw new Error(`malformed rotation reply: ${json}`);
    }
    return { kind: "rotated", generation: record.rotated };
  }
  return { kind: "ack", ...decodePublishAck(json) };
}
