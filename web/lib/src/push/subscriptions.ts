/** Push subscriptions in a document (docs/protocol/03-document.md, D-41,
 * D-42; 04-obligations.md, O-40): an entry per device, under the digest of
 * its endpoint, signed by its subscriber — an unsigned one is never used.
 * Read, verified, written whole, deleted. */
import { type LoroDoc, LoroMap } from "loro-crdt";
import type { Seal } from "../annotations/model.js";
import { sha256 } from "../annotations/sha256.js";
import { subscriptionMessage } from "../identity/messages.js";
import {
  type KnownKey,
  addIdentity,
  readIdentities,
  verify,
} from "../identity/signature.js";

export const SUBSCRIPTIONS = "subscriptions";

const MAX_ENDPOINT_CHARS = 1024;

export interface SubscriptionFields {
  endpoint: string;
  /** The subscription's public key, an uncompressed P-256 point. */
  p256dh: Uint8Array;
  /** Its authentication secret, 16 bytes. */
  auth: Uint8Array;
  /** The fingerprint of the server's VAPID key it was made with (W-65). */
  vapid: Uint8Array;
  createdAt: number;
}

export interface SubscriptionEntry {
  /** Its key in `subscriptions`: the digest of its endpoint (D-41). */
  key: string;
  fields: SubscriptionFields;
  sig?: Uint8Array;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The key of the entry of `endpoint` (D-41). */
export function subscriptionKey(endpoint: string): string {
  return toHex(sha256(new TextEncoder().encode(endpoint)));
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

/** An entry of the form of D-42, its signature not yet checked. */
function readEntry(key: string, value: unknown): SubscriptionEntry | undefined {
  if (!(value instanceof LoroMap)) return undefined;
  const endpoint = value.get("endpoint");
  const p256dh = value.get("p256dh");
  const auth = value.get("auth");
  const vapid = value.get("vapid");
  const createdAt = value.get("createdAt");
  const sig = value.get("sig");
  if (
    typeof endpoint !== "string" ||
    // Characters, as the server counts them (W-59), not UTF-16 units.
    [...endpoint].length > MAX_ENDPOINT_CHARS ||
    !isHttpsUrl(endpoint) ||
    subscriptionKey(endpoint) !== key ||
    !(p256dh instanceof Uint8Array) ||
    p256dh.length !== 65 ||
    p256dh[0] !== 4 ||
    !(auth instanceof Uint8Array) ||
    auth.length !== 16 ||
    !(vapid instanceof Uint8Array) ||
    vapid.length !== 32 ||
    !Number.isSafeInteger(createdAt)
  ) {
    return undefined;
  }
  return {
    key,
    fields: { endpoint, p256dh, auth, vapid, createdAt: createdAt as number },
    ...(sig instanceof Uint8Array && { sig }),
  };
}

/** The entries of the form of D-42, signed or not. */
export function readSubscriptions(
  annotationsDoc: LoroDoc,
): SubscriptionEntry[] {
  const entries: SubscriptionEntry[] = [];
  for (const [key, value] of annotationsDoc.getMap(SUBSCRIPTIONS).entries()) {
    const entry = readEntry(key, value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The valid entries (D-42), each with the key that signed it. */
export async function verifiedSubscriptions(
  annotationsDoc: LoroDoc,
  documentId: string,
): Promise<(SubscriptionEntry & { signer: KnownKey })[]> {
  const known = readIdentities(annotationsDoc);
  const valid: (SubscriptionEntry & { signer: KnownKey })[] = [];
  for (const entry of readSubscriptions(annotationsDoc)) {
    const signer = await verify(entry.sig, known, (fingerprint) =>
      subscriptionMessage(
        { documentId, signer: fingerprint },
        entry.key,
        entry.fields,
      ),
    );
    if (signer) valid.push({ ...entry, signer });
  }
  return valid;
}

/** Writes the entry of `fields`, signed (`seal`), as a whole new map
 * under its key, with the signer's key if the document lacks it, in one
 * commit (O-40, ID-12): of two concurrent writes, one stays whole. */
export function writeSubscription(
  annotationsDoc: LoroDoc,
  fields: SubscriptionFields,
  seal: Seal,
): void {
  const key = subscriptionKey(fields.endpoint);
  const entry = annotationsDoc
    .getMap(SUBSCRIPTIONS)
    .setContainer(key, new LoroMap());
  entry.set("endpoint", fields.endpoint);
  entry.set("p256dh", fields.p256dh);
  entry.set("auth", fields.auth);
  entry.set("vapid", fields.vapid);
  entry.set("createdAt", fields.createdAt);
  entry.set("sig", seal.sig);
  addIdentity(annotationsDoc, seal.signer);
  annotationsDoc.commit();
}

/** Deletes the entry under `key`, if there is one (O-40). */
export function removeSubscription(annotationsDoc: LoroDoc, key: string): void {
  const map = annotationsDoc.getMap(SUBSCRIPTIONS);
  if (map.get(key) === undefined) return;
  map.delete(key);
  annotationsDoc.commit();
}
