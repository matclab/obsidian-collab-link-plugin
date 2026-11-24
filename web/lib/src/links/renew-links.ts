import {
  type Role,
  base64UrlToBytes,
  bytesToBase64Url,
  generateEditSecret,
  verifiers,
} from "../crypto/index.js";

const storageKey = (documentId: string) => `oc:rotation:${documentId}`;

/** The edit secret of a rotation whose outcome this browser doesn't know
 * yet (R-B4), if any. */
export function pendingSecret(
  storage: Storage,
  documentId: string,
): Uint8Array | undefined {
  try {
    const kept = storage.getItem(storageKey(documentId));
    return kept === null ? undefined : base64UrlToBytes(kept);
  } catch {
    return undefined;
  }
}

export function forgetPendingSecret(storage: Storage, documentId: string) {
  try {
    storage.removeItem(storageKey(documentId));
  } catch {
    // nothing kept, or nothing to do about it
  }
}

/** Renews every link of the document (ADR-0019 §5): draws a new edit
 * secret, keeps it in `storage` — before anything is sent, so that a
 * lost reply or a closed tab never leaves the document without an edit
 * link (R-B4) — then sends the rotation. Throws, sending nothing, if the
 * secret can't be kept. The new links come with `onRenewed`. */
export async function renewLinks(
  documentId: string,
  connection: {
    rotate(next: {
      secret: Uint8Array;
      verifiers: Record<Role, Uint8Array>;
    }): Promise<void>;
  },
  storage: Storage,
  /** Keeps the new edit secret wherever else the client keeps its links (a
   * keyring, TR2), before anything is sent. If it rejects, nothing is
   * sent and nothing is left pending. */
  beforeSend?: (secret: Uint8Array) => Promise<void>,
): Promise<void> {
  const secret = generateEditSecret();
  storage.setItem(storageKey(documentId), bytesToBase64Url(secret));
  if (beforeSend) {
    try {
      await beforeSend(secret);
    } catch (error) {
      forgetPendingSecret(storage, documentId);
      throw error;
    }
  }
  await connection.rotate({ secret, verifiers: await verifiers(secret) });
}
