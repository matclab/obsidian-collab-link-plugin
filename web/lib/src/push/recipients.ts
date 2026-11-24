/** Who a reply or a rejection notifies (docs/protocol/03-document.md,
 * D-44): the keys that signed the thread before it — or the suggestion —,
 * never mine, each at its valid subscriptions made with the server's key
 * of now. Every signature is checked here, at the time of sending: none
 * is taken as judged elsewhere (NP1). */
import type { LoroDoc } from "loro-crdt";
import { readAnnotationEntry } from "../annotations/model.js";
import { annotationMessage, replyMessage } from "../identity/messages.js";
import {
  type KnownKey,
  readIdentities,
  verify,
} from "../identity/signature.js";
import {
  type SubscriptionEntry,
  verifiedSubscriptions,
} from "./subscriptions.js";

export interface RecipientQuery {
  annotationsDoc: LoroDoc;
  documentId: string;
  annotationId: string;
  /** A reply: the thread's signers before `replyId` (ID-10's id) are
   * notified. A rejection: the suggestion's signer alone. */
  of: { reply: string } | "rejection";
  /** My keys' fingerprints (ID-5), in hexadecimal: never notified. */
  mine: ReadonlySet<string>;
  /** The fingerprint of the server's VAPID key of now (W-65). */
  vapid: Uint8Array;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The fingerprints of the keys that signed the entries concerned. */
async function signers(query: RecipientQuery): Promise<Set<string>> {
  const { annotationsDoc, documentId, annotationId } = query;
  const entry = readAnnotationEntry(annotationsDoc, annotationId);
  const found = new Set<string>();
  if (!entry) return found;
  const known = readIdentities(annotationsDoc);
  const add = (key: KnownKey | undefined) => {
    if (key) found.add(toHex(key.fingerprint));
  };
  add(
    await verify(entry.sig, known, (signer) =>
      annotationMessage({ documentId, signer }, annotationId, entry.fields),
    ),
  );
  if (query.of === "rejection") return found;
  const { reply } = query.of;
  const position = entry.replies.findIndex((r) => r.id === reply);
  if (position < 0) return new Set();
  // Replies sharing an id are unverified (ID-10).
  const ids = new Map<string, number>();
  for (const r of entry.replies) {
    if (r.id !== undefined) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  }
  for (const r of entry.replies.slice(0, position)) {
    if (r.id === undefined || ids.get(r.id) !== 1) continue;
    add(
      await verify(r.sig, known, (signer) =>
        replyMessage({ documentId, signer }, r.id, {
          annotation: annotationId,
          author: r.author,
          createdAt: r.createdAt,
          body: r.body,
        }),
      ),
    );
  }
  return found;
}

/** The subscriptions to notify (D-44), at most once each. */
export async function recipientsOf(
  query: RecipientQuery,
): Promise<SubscriptionEntry[]> {
  const keys = await signers(query);
  for (const mine of query.mine) keys.delete(mine);
  if (keys.size === 0) return [];
  const subscriptions = await verifiedSubscriptions(
    query.annotationsDoc,
    query.documentId,
  );
  return subscriptions
    .filter(
      (s) =>
        keys.has(toHex(s.signer.fingerprint)) &&
        sameBytes(s.fields.vapid, query.vapid),
    )
    .map(({ signer: _, ...entry }) => entry);
}
