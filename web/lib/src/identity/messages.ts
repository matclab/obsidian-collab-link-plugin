/** The message of each signed object (docs/protocol/06-identity.md, §6.5):
 * built from the values a client reads — whoever wrote them — so that
 * what is verified is what is displayed (SG1). `undefined` when a value
 * isn't of its type (ID-14): the object is then unverified. Synchronous:
 * an index recognises a message it verified already without waiting. */
import { sha256 } from "../annotations/sha256.js";
import { type Canonical, encodeCanonical } from "./cbor.js";

export type SignedKind =
  | "annotation"
  | "reply"
  | "decision"
  | "version"
  | "peer"
  | "presence"
  | "subscription";

/** What every message of a document carries besides the object's own. */
export interface MessageContext {
  /** The `doc` of the document's link. */
  documentId: string;
  /** The signer's fingerprint (ID-5), 32 bytes. */
  signer: Uint8Array;
}

const CONTEXT = "oc-sig/v1";
const MAX_PEER = 2n ** 64n - 1n;

const isText = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value);
const isPeer = (value: unknown): value is string =>
  isText(value) && /^\d{1,20}$/.test(value) && BigInt(value) <= MAX_PEER;

/** The encoded map, or `undefined` if a value can't be encoded (ID-3). */
function encode(
  context: MessageContext,
  kind: SignedKind,
  id: unknown,
  fields: Record<string, Canonical>,
): Uint8Array | undefined {
  if (!isText(id)) return undefined;
  try {
    return encodeCanonical({
      ...fields,
      ctx: CONTEXT,
      kind,
      doc: context.documentId,
      id,
      signer: context.signer,
    });
  } catch {
    return undefined;
  }
}

/** Optional texts: absent, or a text; `null` if neither. */
function optionalTexts(
  values: Record<string, unknown>,
): Record<string, string> | null {
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!isText(value)) return null;
    present[name] = value;
  }
  return present;
}

/** An annotation entry's fields, as read (D-7). */
export interface AnnotationFields {
  type: unknown;
  author: unknown;
  createdAt: unknown;
  body?: unknown;
  note?: unknown;
  change?: unknown;
}

export function annotationMessage(
  context: MessageContext,
  id: unknown,
  fields: AnnotationFields,
): Uint8Array | undefined {
  const { type, author, createdAt, body, note, change } = fields;
  const texts = optionalTexts({ body, note });
  if (
    !isText(type) ||
    !isText(author) ||
    !isInteger(createdAt) ||
    texts === null ||
    !(change === undefined || change instanceof Uint8Array)
  ) {
    return undefined;
  }
  return encode(context, "annotation", id, {
    type,
    author,
    createdAt,
    ...texts,
    ...(change !== undefined && { change: sha256(change) }),
  });
}

/** A reply's fields (D-38, ID-10). */
export interface ReplyFields {
  annotation: unknown;
  author: unknown;
  createdAt: unknown;
  body: unknown;
}

export function replyMessage(
  context: MessageContext,
  id: unknown,
  { annotation, author, createdAt, body }: ReplyFields,
): Uint8Array | undefined {
  if (
    !isText(annotation) ||
    !isText(author) ||
    !isInteger(createdAt) ||
    !isText(body)
  ) {
    return undefined;
  }
  return encode(context, "reply", id, { annotation, author, createdAt, body });
}

/** A decision record's fields (§3.8), `change` decoded. */
export interface DecisionFields {
  annotation: unknown;
  decision: unknown;
  author: unknown;
  change?: unknown;
}

export function decisionMessage(
  context: MessageContext,
  id: unknown,
  { annotation, decision, author, change }: DecisionFields,
): Uint8Array | undefined {
  if (
    !isText(annotation) ||
    !isText(decision) ||
    !isText(author) ||
    !(change === undefined || change instanceof Uint8Array)
  ) {
    return undefined;
  }
  return encode(context, "decision", id, {
    annotation,
    decision,
    author,
    ...(change !== undefined && { change: sha256(change) }),
  });
}

/** A named version's fields (D-20). */
export interface VersionFields {
  name: unknown;
  author: unknown;
  at: unknown;
  frontiers: unknown;
}

/** D-20's frontiers as one text: `<peer>@<counter>`, in order, by `,`. */
function frontiersText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const { peer, counter } = item as Record<string, unknown>;
    if (!isPeer(peer) || !isInteger(counter) || counter < 0) return undefined;
    items.push(`${peer}@${counter}`);
  }
  return items.join(",");
}

export function versionMessage(
  context: MessageContext,
  id: unknown,
  { name, author, at, frontiers }: VersionFields,
): Uint8Array | undefined {
  const text = frontiersText(frontiers);
  if (
    !isText(name) ||
    !isText(author) ||
    !isInteger(at) ||
    text === undefined
  ) {
    return undefined;
  }
  return encode(context, "version", id, { name, author, at, frontiers: text });
}

/** A name in `peers` (D-19), under its peer id. */
export function peerMessage(
  context: MessageContext,
  peer: unknown,
  name: unknown,
): Uint8Array | undefined {
  if (!isPeer(peer) || !isText(name)) return undefined;
  return encode(context, "peer", peer, { name });
}

/** A presence state's fields (D-31). */
export interface PresenceFields {
  seq: unknown;
  name: unknown;
  color: unknown;
}

export function presenceMessage(
  context: MessageContext,
  key: unknown,
  { seq, name, color }: PresenceFields,
): Uint8Array | undefined {
  if (!isInteger(seq) || !isText(name) || !isText(color)) return undefined;
  return encode(context, "presence", key, { seq, name, color });
}

/** A push subscription's fields (D-41). */
export interface SubscriptionFields {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
  vapid: unknown;
  createdAt: unknown;
}

/** Its message: under its key in `subscriptions`, the digest of its
 * endpoint (D-41). */
export function subscriptionMessage(
  context: MessageContext,
  key: unknown,
  { endpoint, p256dh, auth, vapid, createdAt }: SubscriptionFields,
): Uint8Array | undefined {
  if (
    !isText(endpoint) ||
    !(p256dh instanceof Uint8Array) ||
    !(auth instanceof Uint8Array) ||
    !(vapid instanceof Uint8Array) ||
    !isInteger(createdAt)
  ) {
    return undefined;
  }
  return encode(context, "subscription", key, {
    endpoint,
    p256dh,
    auth,
    vapid,
    createdAt,
  });
}
