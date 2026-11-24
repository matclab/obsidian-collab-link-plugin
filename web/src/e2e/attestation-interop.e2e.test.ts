// @vitest-environment node
//
// Phase 18k (docs/protocol/06-identity.md, §6.10; AGENTS.md §1.5): whether
// an object reads under an attested name is decided by every client of a
// document. The official client against the independent one (written from
// the specification alone, its decoder checking each rule of ID-2 as it
// reads where ours re-encodes): the vectors read alike; any bytes near an
// encoding read alike, or are refused by both; hostile attestations —
// fields of every type, keys not configured, signatures altered, bytes
// changed after signing — and hostile revocation lists read alike.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeAll, describe, expect, test } from "vitest";
import { sha256 } from "../../lib/src/annotations/sha256.js";
import { signBytes } from "../../lib/src/identity/keys.js";
import {
  type Canonical,
  attests,
  decodeCanonical,
  encodeCanonical,
  generateIdentityKey,
  readAttestationEntry,
  readRevocationBody,
} from "../../lib/src/index.js";
import { fromHex, vectors } from "../../lib/src/test-support/vectors.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/identity.mjs");
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const v = vectors.identity.attestations;

/** Ours, as the independent client gives it: the key in hexadecimal. */
const plain = (a: Awaited<ReturnType<typeof readAttestationEntry>>) =>
  a ? { ...a, key: hex(a.key) } : null;

describe("the vectors, read alike", () => {
  test("entries, verdicts and revocation lists", async () => {
    for (const entry of [...v.entries, ...v.entries_refused]) {
      const ours = plain(
        await readAttestationEntry(
          entry.key,
          fromHex(entry.value),
          new Set(v.configured),
        ),
      );
      expect(
        independent.attestation(entry.key, fromHex(entry.value), v.configured),
        entry.why ?? entry.key,
      ).toEqual(ours);
    }
    const first = independent.attestation(
      v.entries[0].key,
      fromHex(v.entries[0].value),
      v.configured,
    );
    for (const c of v.verdicts) {
      expect(independent.covers(first, c.date, c.revoked_at)).toBe(c.attested);
    }
    for (const body of [
      ...v.revocation_bodies,
      ...v.revocation_bodies_refused,
    ]) {
      const ours = await readRevocationBody(body.text, new Set(v.configured));
      expect(
        independent.revocationList(body.text, v.configured),
        body.why ?? body.text,
      ).toEqual(
        ours
          ? {
              issuedAt: ours.issuedAt,
              revoked: Object.fromEntries(ours.revoked),
            }
          : null,
      );
    }
  });
});

/** A value of ID-1, or something near one. */
function value(tc: TC, depth: number): Canonical {
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: depth > 0 ? 4 : 3 }))) {
    case 0:
      return tc.draw(gs.booleans());
    case 1:
      return tc.draw(
        gs.oneOf(
          gs.integers({ minValue: -30, maxValue: 70_000 }),
          gs.sampledFrom([2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 32, 255, 256]),
        ),
      );
    case 2:
      return tc.draw(
        gs.sampledFrom(["", "a", "ab", "é", "key", "msg", "sig", "aa"]),
      );
    case 3:
      return Uint8Array.from(tc.draw(gs.binary({ maxSize: 30 })));
    default: {
      const map: Record<string, Canonical> = {};
      for (const key of tc.draw(
        gs.arrays(gs.sampledFrom(["a", "b", "aa", "key", "msg", "__proto__"]), {
          maxSize: 4,
        }),
      )) {
        Object.defineProperty(map, key, {
          value: value(tc, depth - 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return map;
    }
  }
}

/** Bytes near `bytes`: one changed, inserted or removed, or none. */
function near(tc: TC, bytes: Uint8Array): Uint8Array {
  const out = [...bytes];
  const at = tc.draw(gs.integers({ minValue: 0, maxValue: out.length }));
  const byte = tc.draw(
    gs.oneOf(
      gs.integers({ minValue: 0, maxValue: 255 }),
      gs.sampledFrom([
        0x18, 0x19, 0x1a, 0x1b, 0x5f, 0x7f, 0xbf, 0xff, 0x80, 0xf6,
      ]),
    ),
  );
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 3 }))) {
    case 0:
      if (at < out.length) out[at] = byte;
      break;
    case 1:
      out.splice(at, 0, byte);
      break;
    case 2:
      out.splice(at, 1);
      break;
    default:
      break;
  }
  return Uint8Array.from(out);
}

describe("hostile input, read alike", () => {
  test("ID-36: any bytes near an encoding, the same value or refused by both", () =>
    hegel.test((tc) => {
      const bytes = near(tc, encodeCanonical(value(tc, 2)));
      const ours = decodeCanonical(bytes);
      const theirs = independent.decodeStrict(bytes);
      expect(theirs ?? undefined).toEqual(ours);
      if (ours !== undefined) {
        expect(hex(encodeCanonical(ours))).toBe(hex(bytes));
      }
    }));

  let keys: {
    gateway: CryptoKey;
    gatewayPublic: Uint8Array;
    person: Uint8Array;
  }[];
  beforeAll(async () => {
    keys = await Promise.all(
      [0, 1].map(async () => {
        const gateway = await generateIdentityKey();
        const person = await generateIdentityKey();
        return {
          gateway: gateway.privateKey,
          gatewayPublic: gateway.publicKey,
          person: person.publicKey,
        };
      }),
    );
  });

  test("ID-37: hostile attestations, the same reading", () =>
    hegel.testAsync(async (tc) => {
      const k = tc.draw(gs.sampledFrom(keys));
      const configured = [
        hex(sha256((keys[0] as (typeof keys)[0]).gatewayPublic)),
      ];
      const field = (good: Canonical) =>
        tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0
          ? value(tc, 1)
          : good;
      const message: Record<string, Canonical> = {
        ctx: field("oc-attestation/v1"),
        issuer: field("https://idp.test"),
        sub: field("s"),
        name: field("Ada"),
        key: field(k.person),
        issuedAt: field(1_800_000_000),
        expiresAt: field(1_802_592_000),
      };
      if (tc.draw(gs.booleans())) message.email = field("ada@example.org");
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) {
        delete message[tc.draw(gs.sampledFrom(Object.keys(message)))];
      }
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
        message.more = value(tc, 0);
      }
      const msg = encodeCanonical(message);
      let envelope = encodeCanonical({
        key: k.gatewayPublic,
        msg,
        sig: await signBytes(k.gateway, msg),
      });
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) {
        envelope = near(tc, envelope);
      }
      const entryKey = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }))
        ? hex(sha256(envelope))
        : hex(sha256(new Uint8Array([1])));
      const ours = plain(
        await readAttestationEntry(entryKey, envelope, new Set(configured)),
      );
      expect(independent.attestation(entryKey, envelope, configured)).toEqual(
        ours,
      );
      if (ours) {
        const date = tc.draw(
          gs.integers({
            minValue: 1_799_999_999_000,
            maxValue: 1_802_592_001_000,
          }),
        );
        const revokedAt = tc.draw(
          gs.optional(
            gs.integers({ minValue: 1_800_000_000, maxValue: 1_802_600_000 }),
          ),
        );
        const read = await readAttestationEntry(
          entryKey,
          envelope,
          new Set(configured),
        );
        expect(independent.covers(ours, date, revokedAt)).toBe(
          read ? attests(read, date, revokedAt ?? undefined) : false,
        );
      }
    }));

  test("ID-40: hostile revocation lists, the same reading", () =>
    hegel.testAsync(async (tc) => {
      const k = keys[0] as (typeof keys)[0];
      const configured = [hex(sha256(k.gatewayPublic))];
      const revoked: Record<string, Canonical> = {};
      for (
        let n = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
        n > 0;
        n--
      ) {
        const f = tc.draw(
          gs.sampledFrom([
            hex(sha256(k.person)),
            "AB".repeat(32),
            "ab".repeat(31),
            "x",
          ]),
        );
        revoked[f] = tc.draw(gs.booleans()) ? 1_800_000_000 : value(tc, 0);
      }
      const message: Record<string, Canonical> = {
        ctx: tc.draw(
          gs.sampledFrom(["oc-revocations/v1", "oc-attestation/v1"]),
        ),
        issuedAt: tc.draw(gs.booleans()) ? 7 : value(tc, 0),
        revoked: tc.draw(gs.integers({ minValue: 0, maxValue: 5 }))
          ? revoked
          : value(tc, 1),
      };
      const msg = encodeCanonical(message);
      let list = encodeCanonical({
        key: k.gatewayPublic,
        msg,
        sig: await signBytes(k.gateway, msg),
      });
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0)
        list = near(tc, list);
      const encoded = Buffer.from(list).toString("base64url");
      const text = tc.draw(
        gs.sampledFrom([
          JSON.stringify({ issuedAt: 1, list: encoded }),
          JSON.stringify({ list: `${encoded}=` }),
          JSON.stringify([encoded]),
          JSON.stringify({ list: 7 }),
        ]),
      );
      const ours = await readRevocationBody(text, new Set(configured));
      expect(independent.revocationList(text, configured)).toEqual(
        ours
          ? {
              issuedAt: ours.issuedAt,
              revoked: Object.fromEntries(ours.revoked),
            }
          : null,
      );
    }));
});
