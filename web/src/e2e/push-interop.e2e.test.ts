// @vitest-environment node
//
// Phase 34h: the subscriptions of a document (D-41, D-42) and the message a
// receiver shows (D-43), read alike by the official client and the
// independent one (written from the specification alone, on Loro 1.16.3):
// entries signed then altered — a field changed, another key, a broken
// signature, an endpoint not https or too long, in characters or in UTF-16
// units —, and hostile texts.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroMap } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import { generateIdentityKey } from "../../lib/src/identity/keys.js";
import { subscriptionMessage } from "../../lib/src/identity/messages.js";
import {
  addIdentity,
  sign,
  signerOf,
} from "../../lib/src/identity/signature.js";
import { readNotification } from "../../lib/src/push/message.js";
import {
  subscriptionKey,
  verifiedSubscriptions,
} from "../../lib/src/push/subscriptions.js";
import { linkIndependentLoro } from "./independent-loro.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;
// biome-ignore lint/suspicious/noExplicitAny: the other Loro module.
let IndependentLoroDoc: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/push.mjs");
  ({ LoroDoc: IndependentLoroDoc } = await import(
    "../../../independent-client/node_modules/loro-crdt/nodejs/index.js"
  ));
});

const DOC = "0123456789abcdef0123456789abcdef";
type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const ENDPOINTS = [
  "https://fcm.googleapis.com/wp/a",
  "https://web.push.apple.com/b",
  "http://fcm.googleapis.com/wp/c",
  "not a url",
  `https://a.example/${"😀".repeat(1003)}`, // 1 024 characters, 2 024 units
  `https://a.example/${"😀".repeat(1004)}`, // 1 025 characters
];

const HOSTILE: unknown[] = [
  "x",
  "",
  0,
  1.5,
  -1,
  Number.MAX_SAFE_INTEGER + 1,
  true,
  new Uint8Array(0),
  new Uint8Array(16),
  new Uint8Array(32),
  Uint8Array.of(4, ...new Uint8Array(64)),
  Uint8Array.of(2, ...new Uint8Array(64)),
];

describe("subscriptions and messages, read alike by the official and the independent client", () => {
  test("D-42: the same valid entries, signed by the same keys", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const doc = new LoroDoc();
        const key = await signerOf(await generateIdentityKey());
        const other = await signerOf(await generateIdentityKey());
        addIdentity(doc, key);
        if (tc.draw(gs.booleans())) addIdentity(doc, other);
        doc.commit();
        const map = doc.getMap("subscriptions");
        const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        for (let i = 0; i < count; i++) {
          const fields: Record<string, unknown> = {
            endpoint: tc.draw(gs.sampledFrom(ENDPOINTS)),
            p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(i)),
            auth: new Uint8Array(16).fill(i),
            vapid: new Uint8Array(32).fill(7),
            createdAt: 1000 + i,
          };
          let name = subscriptionKey(fields.endpoint as string);
          let sig: Uint8Array;
          try {
            sig = await sign(tc.draw(gs.booleans()) ? key : other, (s) =>
              subscriptionMessage(
                { documentId: DOC, signer: s },
                name,
                fields as never,
              ),
            );
          } catch {
            sig = new Uint8Array(72);
          }
          // Altered after signing, sometimes.
          switch (tc.draw(gs.integers({ minValue: 0, maxValue: 5 }))) {
            case 0: {
              const field = tc.draw(
                gs.sampledFrom([
                  "endpoint",
                  "p256dh",
                  "auth",
                  "vapid",
                  "createdAt",
                ]),
              );
              fields[field] = tc.draw(gs.sampledFrom(HOSTILE));
              break;
            }
            case 1:
              name = subscriptionKey(`${fields.endpoint}x`);
              break;
            case 2:
              sig = sig.slice();
              sig[71] = (sig[71] as number) ^ 1;
              break;
            default:
          }
          if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
            map.set(name, "not a map");
            continue;
          }
          const entry = map.setContainer(name, new LoroMap());
          for (const [field, value] of Object.entries(fields)) {
            entry.set(field, value as never);
          }
          if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) > 0) {
            entry.set("sig", sig);
          }
        }
        doc.commit();
        const mine = (await verifiedSubscriptions(doc, DOC))
          .map((s) => ({ key: s.key, signer: hex(s.signer.fingerprint) }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const theirs = new IndependentLoroDoc();
        theirs.import(doc.export({ mode: "snapshot" }));
        expect(mine).toEqual(independent.subscriptions(theirs, DOC));
      },
      { testCases: 200 },
    ));

  test("D-43: the same message shown, or none", () =>
    hegel.test(
      (tc: TC) => {
        const base: Record<string, unknown> = {
          v: 1,
          kind: "reply",
          doc: DOC,
          annotation: "a",
          title: "T",
          name: "N",
          excerpt: "E",
        };
        const text = tc.draw(gs.booleans())
          ? tc.draw(gs.text({ maxSize: 60 }))
          : (() => {
              const message = { ...base };
              const field = tc.draw(
                gs.sampledFrom([...Object.keys(base), "extra"]),
              );
              if (tc.draw(gs.booleans())) delete message[field];
              else
                message[field] = tc.draw(
                  gs.sampledFrom([
                    2,
                    "rejected",
                    "accepted",
                    DOC.toUpperCase(),
                    null,
                    [],
                    "",
                    "x",
                  ]),
                );
              return JSON.stringify(
                tc.draw(gs.booleans()) ? message : [message],
              );
            })();
        const mine = readNotification(text) ?? null;
        expect(mine).toEqual(independent.readMessage(text));
      },
      { testCases: 400 },
    ));
});
