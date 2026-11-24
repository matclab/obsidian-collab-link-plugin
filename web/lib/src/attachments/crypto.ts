/** An attached image's identifier and encryption (docs/protocol/01-wire.md
 * §1.12, W-53; 02-links-and-encryption.md, K-19): the content key, with
 * the document and the image as associated data, so that the server can't
 * serve one image in place of another. Pure, but for WebCrypto. */
import { decrypt, encrypt } from "../crypto/aead.js";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";

const ID_BYTES = 16;
const DOMAIN = "obsidian-collab/attachment/v1";

/** A fresh identifier (W-53): 16 random bytes, in base64url. */
export function newAttachmentId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/** Whether `text` is an identifier (W-53): 16 bytes, in their one
 * base64url encoding (22 characters, the last one's unused bits zero). */
export function isAttachmentId(text: string): boolean {
  if (text.length !== 22) return false;
  try {
    const bytes = base64UrlToBytes(text);
    return bytes.length === ID_BYTES && bytesToBase64Url(bytes) === text;
  } catch {
    return false;
  }
}

function associatedData(documentId: string, attachmentId: string): Uint8Array {
  return new TextEncoder().encode(`${DOMAIN}\0${documentId}\0${attachmentId}`);
}

/** K-19: the blob of an image's bytes. */
export function encryptAttachment(
  key: CryptoKey,
  documentId: string,
  attachmentId: string,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return encrypt(key, bytes, associatedData(documentId, attachmentId));
}

/** K-19: the bytes of a blob fetched under these identifiers; rejects one
 * that doesn't decrypt under them (altered, another image's, another
 * document's). */
export function decryptAttachment(
  key: CryptoKey,
  documentId: string,
  attachmentId: string,
  blob: Uint8Array,
): Promise<Uint8Array> {
  return decrypt(key, blob, associatedData(documentId, attachmentId));
}
