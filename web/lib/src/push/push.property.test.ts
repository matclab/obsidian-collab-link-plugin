// K-20, D-43: what a sender encrypts, a receiver written from RFC 8291
// alone reads back, padded to one record of 2 048 bytes; and a receiver
// reads any text without throwing, showing only what is of D-43's form.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { decryptPush, p256Pair } from "../test-support/rfc8291.js";
import {
  NotificationTooLong,
  RECORD_BYTES,
  encryptNotification,
} from "./encrypt.js";
import {
  NOTIFICATION_LIMITS,
  type NotificationMessage,
  encodeNotification,
  readNotification,
} from "./message.js";
import { SUBSCRIPTIONS, readSubscriptions } from "./subscriptions.js";

const DOC = "0123456789abcdef0123456789abcdef";

describe("notifications, as properties", () => {
  test("K-20: a receiver of the RFC reads back what was encrypted, in one padded record", () =>
    hegel.testAsync(
      async (tc) => {
        const receiver = p256Pair();
        const auth = tc.draw(gs.binary({ minSize: 16, maxSize: 16 }));
        const message = tc.draw(gs.text({ maxSize: 700 }));
        const bytes = new TextEncoder().encode(message);
        let payload: Uint8Array;
        try {
          payload = await encryptNotification(message, {
            p256dh: receiver.publicKey,
            auth,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(NotificationTooLong);
          expect(bytes.length).toBeGreaterThanOrEqual(RECORD_BYTES);
          return;
        }
        expect(payload.length).toBe(86 + RECORD_BYTES + 16);
        const read = decryptPush(payload, receiver.privateKey, auth);
        expect(read.recordSize).toBe(4096);
        expect(read.recordLength).toBe(RECORD_BYTES);
        expect(new TextDecoder().decode(read.plaintext)).toBe(
          new TextDecoder().decode(bytes),
        );
      },
      { testCases: 50 },
    ));

  test("D-43: a message a sender writes always fits its record and reads back", () =>
    hegel.test((tc) => {
      const text = () => tc.draw(gs.text({ maxSize: 400 }));
      const message: NotificationMessage = {
        kind: tc.draw(gs.sampledFrom(["reply", "rejected"] as const)),
        doc: DOC,
        annotation: crypto.randomUUID(),
        title: text(),
        name: text(),
        excerpt: text(),
      };
      const encoded = encodeNotification(message);
      expect(new TextEncoder().encode(encoded).length).toBeLessThan(
        RECORD_BYTES,
      );
      const read = readNotification(encoded);
      expect(read).toBeDefined();
      for (const field of ["title", "name", "excerpt"] as const) {
        expect(read?.[field].length).toBeLessThanOrEqual(
          NOTIFICATION_LIMITS[field],
        );
      }
      expect(encodeNotification(read as NotificationMessage)).toBe(encoded);
    }));

  test("D-43: any text is read without throwing", () =>
    hegel.test((tc) => {
      const text = tc.draw(
        gs.oneOf(
          gs.text({ maxSize: 200 }),
          gs.text({ maxSize: 40 }).map((t) =>
            JSON.stringify({
              v: 1,
              kind: "reply",
              doc: DOC,
              annotation: t,
              title: t,
              name: t,
              excerpt: t,
            }),
          ),
        ),
      );
      readNotification(text);
    }));

  test("D-42: any entry is read without throwing, and only well-formed ones are kept", () =>
    hegel.test((tc) => {
      const doc = new LoroDoc();
      const map = doc.getMap(SUBSCRIPTIONS);
      const entries = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      for (let i = 0; i < entries; i++) {
        const key = tc.draw(gs.text({ maxSize: 64 }));
        if (tc.draw(gs.booleans())) {
          map.set(key, tc.draw(gs.text({ maxSize: 10 })));
          continue;
        }
        const entry = map.setContainer(key, new LoroMap());
        const value = (): unknown => {
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))) {
            case 0:
              return tc.draw(gs.text({ maxSize: 30 }));
            case 1:
              return tc.draw(gs.binary({ maxSize: 70 }));
            default:
              return tc.draw(gs.integers({ minValue: -5, maxValue: 5 }));
          }
        };
        for (const field of [
          "endpoint",
          "p256dh",
          "auth",
          "vapid",
          "createdAt",
          "sig",
        ]) {
          if (tc.draw(gs.booleans())) entry.set(field, value() as never);
        }
      }
      doc.commit();
      for (const s of readSubscriptions(doc)) {
        expect(s.fields.p256dh.length).toBe(65);
        expect(s.fields.auth.length).toBe(16);
        expect(s.fields.vapid.length).toBe(32);
      }
    }));
});
