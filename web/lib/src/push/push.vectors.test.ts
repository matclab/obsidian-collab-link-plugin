// Notifications against the specification's vectors
// (docs/protocol/02-links-and-encryption.md K-20, 03-document.md §3.11,
// 06-identity.md §6.5; docs/protocol/vectors.json, section `push`).
import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { subscriptionMessage } from "../identity/messages.js";
import { decryptPush } from "../test-support/rfc8291.js";
import { fromHex, fromUtf16, toHex, vectors } from "../test-support/vectors.js";
import { encryptNotification } from "./encrypt.js";
import {
  NOTIFICATION_LIMITS,
  encodeNotification,
  notificationText,
  readNotification,
} from "./message.js";
import {
  SUBSCRIPTIONS,
  subscriptionKey,
  verifiedSubscriptions,
} from "./subscriptions.js";

const { push, identity } = vectors;

interface VectorFields {
  endpoint: string;
  p256dh_hex: string;
  auth_hex: string;
  vapid_hex: string;
  createdAt: number;
}

const fieldsOf = (f: VectorFields) => ({
  endpoint: f.endpoint,
  p256dh: fromHex(f.p256dh_hex),
  auth: fromHex(f.auth_hex),
  vapid: fromHex(f.vapid_hex),
  createdAt: f.createdAt,
});

/** A document holding the signer's key and these entries, as given. */
function documentWith(
  entries: { key: string; fields: VectorFields; sig: string | null }[],
): LoroDoc {
  const doc = new LoroDoc();
  doc
    .getMap("identities")
    .set(identity.key.fingerprint, fromHex(identity.key.public_key));
  const map = doc.getMap(SUBSCRIPTIONS);
  for (const { key, fields, sig } of entries) {
    const entry = map.setContainer(key, new LoroMap());
    const f = fieldsOf(fields);
    entry.set("endpoint", f.endpoint);
    entry.set("p256dh", f.p256dh);
    entry.set("auth", f.auth);
    entry.set("vapid", f.vapid);
    entry.set("createdAt", f.createdAt);
    if (sig !== null) entry.set("sig", fromHex(sig));
  }
  doc.commit();
  return doc;
}

describe("notifications, as the vectors say", () => {
  test("K-20: RFC 8291's own example is read by the RFC's receiver", () => {
    const e = push.rfc8291_example;
    const { plaintext } = decryptPush(
      fromHex(e.payload),
      fromHex(e.ua_private),
      fromHex(e.auth),
    );
    expect(Buffer.from(plaintext).toString("hex")).toBe(e.plaintext);
  });

  test("K-20: the same keys and salt give RFC 8291's payload, and the vectors' padded one", async () => {
    const e = push.rfc8291_example;
    const rfc = await encryptNotification(
      new TextDecoder().decode(fromHex(e.plaintext)),
      { p256dh: fromHex(e.ua_public), auth: fromHex(e.auth) },
      { ephemeral: fromHex(e.as_private), salt: fromHex(e.salt), record: null },
    );
    expect(toHex(rfc)).toBe(e.payload);
    for (const p of push.payloads) {
      const payload = await encryptNotification(
        p.message,
        { p256dh: fromHex(p.ua_public), auth: fromHex(p.auth) },
        { ephemeral: fromHex(p.as_private), salt: fromHex(p.salt) },
      );
      expect(toHex(payload)).toBe(p.payload);
      expect(payload.length).toBe(p.length);
    }
  });

  test("D-41, §6.5: a subscription's key and message are those of the vectors", () => {
    for (const s of push.subscriptions) {
      expect(subscriptionKey(s.fields.endpoint)).toBe(s.key);
      const message = subscriptionMessage(
        {
          documentId: identity.document_id,
          signer: fromHex(identity.key.fingerprint),
        },
        s.key,
        fieldsOf(s.fields),
      );
      expect(message && toHex(message)).toBe(s.message);
    }
  });

  test("D-42: a valid entry is signed by its subscriber; any other is ignored", async () => {
    const doc = documentWith(push.subscriptions);
    const valid = await verifiedSubscriptions(doc, identity.document_id);
    expect(valid.map((s) => s.key)).toEqual(
      push.subscriptions.map((s: { key: string }) => s.key),
    );
    expect(toHex(valid[0]?.signer.fingerprint ?? new Uint8Array())).toBe(
      identity.key.fingerprint,
    );
    for (const ignored of push.subscriptions_ignored) {
      const alone = documentWith([ignored]);
      expect(
        await verifiedSubscriptions(alone, identity.document_id),
        ignored.why,
      ).toEqual([]);
    }
  });

  test("D-43: a sender's texts, cleaned and shortened", () => {
    for (const t of push.message_texts) {
      const input = t.input ?? fromUtf16(t.input_utf16);
      const limit =
        NOTIFICATION_LIMITS[t.field as keyof typeof NOTIFICATION_LIMITS];
      expect(notificationText(input, limit), t.why).toBe(t.output);
    }
  });

  test("D-43: what a receiver shows, and what it doesn't", () => {
    for (const text of push.messages_shown) {
      const read = readNotification(text);
      expect(read, text).toBeDefined();
      expect(encodeNotification(read as never)).toBe(
        encodeNotification(JSON.parse(text)),
      );
    }
    for (const { why, text } of push.messages_not_shown) {
      expect(readNotification(text), why).toBeUndefined();
    }
  });
});
