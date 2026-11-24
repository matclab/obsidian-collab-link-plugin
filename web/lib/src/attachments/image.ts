/** An image, from a file to a blob and back (ADR-0057 §1, D-40, K-19):
 * what a client does on each side of `http.ts`. Pure, but for WebCrypto. */
import {
  decryptAttachment,
  encryptAttachment,
  newAttachmentId,
} from "./crypto.js";
import { type ImageFormat, imageFormat } from "./format.js";
import { stripMetadata } from "./metadata.js";

/** A file ready to upload: its identifier, drawn, its format, its bytes
 * without their metadata, and its blob — those bytes encrypted. */
export interface PreparedImage {
  attachmentId: string;
  format: ImageFormat;
  bytes: Uint8Array;
  blob: Uint8Array;
}

/** Why a file isn't uploaded. */
export type Unprepared = "not-an-image" | "malformed";

export async function prepareImage(
  key: CryptoKey,
  documentId: string,
  file: Uint8Array,
): Promise<PreparedImage | Unprepared> {
  const format = imageFormat(file);
  if (format === null) return "not-an-image";
  const bytes = stripMetadata(file, format);
  if (bytes === null) return "malformed";
  const attachmentId = newAttachmentId();
  const blob = await encryptAttachment(key, documentId, attachmentId, bytes);
  return { attachmentId, format, bytes, blob };
}

/** A downloaded image, shown only if it decrypts under its identifiers
 * and is of one of D-40's formats. */
export interface OpenedImage {
  format: ImageFormat;
  bytes: Uint8Array;
}

/** Never throws: anything else is `unreadable` (D-40). */
export async function openImage(
  key: CryptoKey,
  documentId: string,
  attachmentId: string,
  blob: Uint8Array,
): Promise<OpenedImage | "unreadable"> {
  let bytes: Uint8Array;
  try {
    bytes = await decryptAttachment(key, documentId, attachmentId, blob);
  } catch {
    return "unreadable";
  }
  const format = imageFormat(bytes);
  return format === null ? "unreadable" : { format, bytes };
}
