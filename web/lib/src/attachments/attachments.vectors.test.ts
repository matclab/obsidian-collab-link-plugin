// Attached images against the specification's vectors
// (docs/protocol/01-wire.md §1.12, K-19, D-40; docs/protocol/vectors.json,
// section `attachment`).
import { describe, expect, test } from "vitest";
import { importKeyFromBase64Url } from "../crypto/aead.js";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import {
  decryptAttachment,
  encryptAttachment,
  isAttachmentId,
} from "./crypto.js";
import { imageFormat } from "./format.js";

const { attachment, keys } = vectors;

describe("attached images, as the vectors say", () => {
  test("W-53: identifiers are read, or refused", () => {
    for (const id of attachment.ids) expect(isAttachmentId(id)).toBe(true);
    for (const { why, id } of attachment.ids_refused)
      expect(isAttachmentId(id), why).toBe(false);
  });

  test("K-19: an image's blob decrypts under its document and identifier only", async () => {
    const key = await importKeyFromBase64Url(keys.content_key.base64url);
    for (const {
      document_id,
      attachment_id,
      plaintext,
      blob,
    } of attachment.blobs) {
      const bytes = await decryptAttachment(
        key,
        document_id,
        attachment_id,
        fromHex(blob),
      );
      expect(toHex(bytes)).toBe(plaintext);
      const again = await encryptAttachment(
        key,
        document_id,
        attachment_id,
        fromHex(plaintext),
      );
      expect(
        toHex(await decryptAttachment(key, document_id, attachment_id, again)),
      ).toBe(plaintext);
    }
    for (const {
      why,
      document_id,
      attachment_id,
      blob,
    } of attachment.blobs_that_dont_decrypt) {
      await expect(
        decryptAttachment(key, document_id, attachment_id, fromHex(blob)),
        why,
      ).rejects.toThrow();
    }
  });

  test("D-40: an image's format, by its bytes alone", () => {
    for (const { why, bytes, format } of attachment.formats) {
      expect(imageFormat(fromHex(bytes)), why).toBe(format);
    }
  });
});
