// The keys of a keyring (KR-46; phase 23, AF6):
// - the decoder: a `keys` of arbitrary names and values never throws, and
//   lists only 32 acceptable bytes under an integer, each once;
// - devices adding keys to their copies and exchanging them in any order
//   all list, once each has the others' operations, every key added; a
//   key listed on a device never leaves it.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import { isAcceptablePublicKey } from "../identity/keys.js";
import { newKeyringDoc } from "./model.js";
import { addOwnKey, ownKeys } from "./own-keys.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const KEYS = [0xa0, 0xb0, 0xc0, 0xd0].map((b) => new Uint8Array(32).fill(b));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const respelled = (key: Uint8Array) => {
  const text = bytesToBase64Url(key);
  const last = ALPHABET.indexOf(text.at(-1) ?? "A");
  return `${text.slice(0, -1)}${ALPHABET[last | 3]}`;
};

describe("the keys of a keyring (property)", () => {
  test(
    "arbitrary entries: no exception, only well-formed keys, each once",
    () =>
      hegel.test(
        (tc: TC) => {
          const doc = newKeyringDoc();
          const map = doc.getMap("keys");
          const n = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
          for (let i = 0; i < n; i++) {
            const name = tc.draw(
              gs.oneOf(
                gs.text({ maxSize: 50 }),
                gs
                  .binary({ minSize: 0, maxSize: 40 })
                  .map((b) => bytesToBase64Url(b)),
                gs.sampledFrom(KEYS.map((k) => bytesToBase64Url(k))),
                // Another spelling of the same key: its last character's
                // two padding bits set (K-2 reads it as the same bytes).
                gs.sampledFrom(KEYS.map((k) => respelled(k))),
              ),
            );
            const value = tc.draw(
              gs.oneOf<unknown>(
                gs.integers(),
                gs.text({ maxSize: 5 }),
                gs.booleans(),
                gs.just(1.5),
                gs.binary({ maxSize: 4 }),
              ),
            );
            map.set(name, value);
          }
          doc.commit();
          const listed = ownKeys(doc).map(hex);
          if (new Set(listed).size !== listed.length) {
            throw new Error(`listed twice: ${listed}`);
          }
          // Each listed key under one of its spellings, of integer value.
          const entries = [...map.entries()];
          for (const key of ownKeys(doc)) {
            const under = entries.some(([name, value]) => {
              let bytes: Uint8Array;
              try {
                bytes = base64UrlToBytes(name);
              } catch {
                return false;
              }
              return (
                hex(bytes) === hex(key) &&
                typeof value === "number" &&
                Number.isSafeInteger(value)
              );
            });
            if (key.length !== 32 || !isAcceptablePublicKey(key) || !under) {
              throw new Error(`listed: ${hex(key)}`);
            }
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );

  test(
    "AF6: added on any device, exchanged in any order, every key listed everywhere; none ever leaves",
    () =>
      hegel.test(
        (tc: TC) => {
          const devices = Array.from({ length: 3 }, () => {
            const doc = new LoroDoc();
            doc.import(newKeyringDoc().export({ mode: "snapshot" }));
            return doc;
          });
          const added = new Set<string>();
          const listedOn = devices.map(() => new Set<string>());
          const check = () => {
            devices.forEach((doc, i) => {
              const now = new Set(ownKeys(doc).map(hex));
              for (const key of listedOn[i] ?? []) {
                if (!now.has(key)) throw new Error(`${key} left device ${i}`);
              }
              listedOn[i] = now;
            });
          };
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
          for (let s = 0; s < steps; s++) {
            const a = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
            const doc = devices[a];
            if (!doc) continue;
            if (tc.draw(gs.booleans())) {
              const key = tc.draw(gs.sampledFrom(KEYS));
              addOwnKey(doc, key, tc.draw(gs.integers({ minValue: 0 })));
              added.add(hex(key));
            } else {
              const b = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
              const from = devices[b];
              if (from) doc.import(from.export({ mode: "update" }));
            }
            check();
          }
          for (const doc of devices) {
            for (const from of devices) {
              doc.import(from.export({ mode: "update" }));
            }
          }
          check();
          for (const doc of devices) {
            const listed = ownKeys(doc).map(hex).sort();
            if (listed.join() !== [...added].sort().join()) {
              throw new Error(`listed ${listed}, added ${[...added]}`);
            }
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
