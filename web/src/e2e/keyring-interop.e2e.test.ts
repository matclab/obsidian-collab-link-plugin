// @vitest-environment node
//
// Phase 18c (docs/protocol/05-keyring.md, KR-16, KR-21, KR-22; AGENTS.md
// §1.5): what a keyring lists is decided by every device of a person,
// maybe of different clients. The official reader against the independent
// client's (written from the specification alone), on hostile keyrings —
// values of every type, links under another link's secret, an empty or
// repeated `doc`, `seen` of any type and equal for two links, refused
// secrets naming the wrong document — and on hostile keyring links: both
// list the same documents, in the same states, with the same links; both
// accept the same keyring links. Phase 18f (KR-35, KR-36): the deposits
// that add a device and the pairing addresses, hostile too, are read alike,
// and as the vectors say. Phase 18i (KR-42, KR-43): an account's key, its
// deposits and its addresses, alike too.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../../lib/src/crypto/role-secrets.js";
import {
  encryptKeyring,
  formatKeyringLink,
  listKeyring,
  openAccountPairing,
  openPairing,
  parseAccountKey,
  parseKeyringLink,
  readKeyringPlaintext,
  readPairingAddress,
} from "../../lib/src/index.js";
import { fromHex, vectors } from "../../lib/src/test-support/vectors.js";
import { linkIndependentLoro } from "./independent-loro.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/keyring.mjs");
});

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const DOCS = ["d1", "d2", "d3", ""];
const ROLES = ["read", "suggest", "edit"];
const secret = (n: number) => bytesToBase64Url(new Uint8Array(32).fill(n));

/** A link as a keyring may hold one, and the secret it names, if any. */
function hostileLink(tc: TC): { link: string; secret: string | null } {
  // Mostly one document, one role: links that compare by `seen`.
  const doc = tc.draw(gs.sampledFrom([...DOCS, "d1", "d1"]));
  const role = tc.draw(gs.sampledFrom([...ROLES, "edit", "edit", "admin"]));
  const s = secret(tc.draw(gs.integers({ minValue: 1, maxValue: 6 })));
  const plain = {
    link: `https://h/?doc=${doc}#k=${KEY}&r=${role}.${s}`,
    secret: s,
  };
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: 9 }))) {
    case 0:
      return {
        link: `https://h/?doc=${doc}&doc=d9#k=${KEY}&r=${role}.${s}`,
        secret: s,
      };
    case 1:
      return {
        link: `https://h/?doc=${encodeURIComponent(doc).replace(/d/, "%64")}#k=${KEY}&r=${role}.${s}`,
        secret: s,
      };
    case 2:
      return { link: `https://h/?doc=${doc}#k=${KEY}`, secret: null };
    case 3:
      return {
        link: `https://h/?doc=${doc}#r=${role}.${s}&k=${KEY}`,
        secret: s,
      };
    case 4:
      return { link: `not a url ${doc}`, secret: null };
    case 5:
      return {
        link: `https://h/?x=1&doc=${doc}#k=${KEY}&r=${role}.${s}=`,
        secret: `${s}=`,
      };
    default:
      return plain;
  }
}

function hostileKeyring(tc: TC): Uint8Array {
  const doc = new LoroDoc();
  const value = (): unknown =>
    tc.draw(
      gs.sampledFrom<unknown>([
        null,
        true,
        false,
        0,
        -1,
        1.5,
        2 ** 53,
        100,
        200,
        "",
        "d1",
        "later",
        [1],
        { a: 1 },
      ]),
    );
  const anySecret = () =>
    secret(tc.draw(gs.integers({ minValue: 1, maxValue: 6 })));
  for (
    let i = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
    i > 0;
    i--
  ) {
    switch (tc.draw(gs.integers({ minValue: 0, maxValue: 6 }))) {
      case 0:
      case 1: {
        // KR-20: a link under its own secret, mostly; under another, or a
        // non-text value, sometimes.
        const { link, secret: own } = hostileLink(tc);
        const key =
          own && tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
            ? own
            : anySecret();
        doc
          .getMap("links")
          .set(
            key,
            tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
              ? (value() as never)
              : link,
          );
        // Often seen at once: links that compare by `seen`.
        if (tc.draw(gs.booleans())) {
          doc.getMap("seen").set(key, tc.draw(gs.sampledFrom([100, 200, 300])));
        }
        break;
      }
      case 2:
        doc
          .getMap("seen")
          .set(
            anySecret(),
            (tc.draw(gs.booleans())
              ? tc.draw(gs.integers({ minValue: 0, maxValue: 400 }))
              : value()) as never,
          );
        break;
      case 3:
        doc
          .getMap("failed")
          .set(
            anySecret(),
            tc.draw(gs.sampledFrom<unknown>([...DOCS, 7, null])) as never,
          );
        break;
      default: {
        const root = tc.draw(
          gs.sampledFrom([
            "title",
            "opened",
            "created",
            "deleted",
            "excluded",
            "meta",
            "other",
            "edit",
          ]),
        );
        doc.getMap(root).set(tc.draw(gs.sampledFrom(DOCS)), value() as never);
      }
    }
  }
  doc.commit();
  return doc.export({ mode: "snapshot" });
}

const official = (bytes: Uint8Array) => {
  const doc = readKeyringPlaintext(bytes);
  return (doc ? listKeyring(doc) : []).map((e) => ({
    document_id: e.documentId,
    state: e.state,
    role: e.role,
    link: e.link,
    title: e.title,
    opened_at: e.openedAt,
    created_here: e.createdHere,
    excluded: e.excluded,
  }));
};

describe("the keyring, read by the official and the independent client", () => {
  test("KR-21, KR-22: hostile keyrings list the same", () =>
    hegel.test(
      (tc: TC) => {
        const bytes = hostileKeyring(tc);
        const theirs = independent.listKeyring(independent.readKeyring(bytes));
        expect(official(bytes)).toEqual(theirs);
      },
      { testCases: 400 },
    ));

  test("KR-16: hostile keyring links are accepted alike", () =>
    hegel.test(
      (tc: TC) => {
        const id = tc.draw(
          gs.sampledFrom([
            "0123456789abcdef0123456789abcdef",
            "0123456789ABCDEF0123456789ABCDEF",
            "abc",
          ]),
        );
        const part = () =>
          tc.draw(
            gs.sampledFrom([
              secret(1),
              `${secret(1)}=`,
              secret(1).slice(1),
              `${secret(1)}A`,
              secret(1).replace(/A/g, "+"),
              "",
              "%41",
            ]),
          );
        const space = () =>
          tc.draw(gs.sampledFrom(["", " ", "\n", "\t", " ", " "]));
        const prefix = tc.draw(
          gs.sampledFrom([
            "oc-keyring:v1:",
            "oc-keyring:v2:",
            "OC-KEYRING:v1:",
            "",
          ]),
        );
        const extra = tc.draw(gs.booleans()) ? `.${part()}` : "";
        const text = `${space()}${prefix}${id}.${part()}.${part()}${extra}${space()}`;
        let mine: unknown = null;
        try {
          const parsed = parseKeyringLink(text);
          mine = [
            parsed.keyringId,
            bytesToBase64Url(parsed.secret),
            bytesToBase64Url(parsed.key),
          ];
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        const t = independent.parseKeyringLink(text);
        const theirs = t && [
          t.keyringId,
          bytesToBase64Url(t.secret),
          bytesToBase64Url(t.key),
        ];
        expect(mine).toEqual(theirs);
      },
      { testCases: 400 },
    ));

  test("KR-36: hostile deposits are opened alike", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const pairingKey = new Uint8Array(32).fill(0x91);
        const link = `oc-keyring:v1:${"ab".repeat(16)}.${secret(1)}.${secret(2)}`;
        const keyring = tc.draw(
          gs.sampledFrom<unknown>([
            link,
            link,
            ` ${link}\t`,
            link.replace("v1", "v2"),
            `${link}.${secret(3)}`,
            link.slice(0, -1),
            [link],
            null,
          ]),
        );
        const v = tc.draw(
          gs.sampledFrom<unknown>([1, 1, 2, "1", 1.0, true, null, undefined]),
        );
        const text = tc.draw(
          gs.sampledFrom([
            JSON.stringify({ v, keyring }),
            JSON.stringify({ v, keyring, other: { v: 2 } }),
            JSON.stringify([v, keyring]),
            JSON.stringify(keyring),
            `{"v":1,"keyring":${JSON.stringify(keyring)}`,
            `{"v":1,"v":${JSON.stringify(v)},"keyring":${JSON.stringify(keyring)}}`,
          ]),
        );
        let plaintext = new TextEncoder().encode(text);
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) {
          plaintext = new Uint8Array([...plaintext, 0xc3]);
        }
        const deposit = await encryptKeyring(pairingKey, plaintext);
        let mine: string | null = null;
        try {
          mine = formatKeyringLink(await openPairing(pairingKey, deposit));
        } catch {}
        const t = await independent.openPairing(pairingKey, deposit);
        expect(mine).toEqual(t && formatKeyringLink(t));
      },
      { testCases: 400 },
    ));

  test("KR-35: hostile pairing addresses are read alike", () =>
    hegel.test(
      (tc: TC) => {
        const id = tc.draw(
          gs.sampledFrom([
            "fedcba9876543210fedcba9876543210",
            "fedcba9876543210fedcba9876543210",
            "fedcba9876543210fedcba9876543210",
            "fedcba9876543210fedcba9876543210",
            "FEDCBA9876543210FEDCBA9876543210",
            "fedcba",
            "",
          ]),
        );
        const query = tc.draw(
          gs.sampledFrom([
            `?pair=${id}`,
            `?pair=${id}`,
            `?pair=${id}`,
            `?pair=${id}`,
            `?pair=${id}&pair=${id}`,
            `?doc=x&pair=${id}`,
            `?pair=${encodeURIComponent(` ${id}`)}`,
            "?doc=x",
            "",
          ]),
        );
        // KR-43: an account's, or not one.
        const account = tc.draw(
          gs.sampledFrom([
            "",
            "",
            "&account",
            "&account=",
            "&account=1",
            "&account=1",
            "&account&account",
            "&account&account",
            "&Account",
          ]),
        );
        const value = tc.draw(
          gs.sampledFrom([
            secret(5),
            secret(5),
            secret(5),
            secret(5),
            `${secret(5).slice(0, 42)}B`,
            `${secret(5)}=`,
            secret(5).slice(1),
            `${secret(5)}A`,
            `${secret(5)}&x=1`,
            secret(5).replace(/A/g, "+"),
          ]),
        );
        const name = tc.draw(
          gs.sampledFrom(["#p=", "#p=", "#p=", "#p=", "#k=", "#", ""]),
        );
        const hash = name === "" ? "" : `${name}${value}`;
        let mine: unknown;
        try {
          const read = readPairingAddress(`${query}${account}`, hash);
          mine = read && [
            read.pairingId,
            bytesToBase64Url(read.key),
            read.account,
          ];
        } catch {
          mine = null;
        }
        const t = independent.readPairingAddress(`${query}${account}`, hash);
        expect(mine).toEqual(
          t && [t.pairingId, bytesToBase64Url(t.key), t.account],
        );
      },
      { testCases: 400 },
    ));

  test("KR-42: hostile account keys are accepted alike", () =>
    hegel.test(
      (tc: TC) => {
        const key = secret(7);
        const text = tc.draw(
          gs.sampledFrom([
            `oc-keyring:v1:${key}`,
            ` oc-keyring:v1:${key}\n`,
            `oc-keyring:v1:${key.slice(0, 42)}B`,
            `oc-keyring:v1:${key}=`,
            `oc-keyring:v1:${key.slice(1)}`,
            `oc-keyring:v1:${key}A`,
            `oc-keyring:v1:${key}.${key}`,
            `oc-keyring:v1:${"ab".repeat(16)}.${key}.${key}`,
            `oc-keyring:v2:${key}`,
            `OC-KEYRING:v1:${key}`,
            `oc-keyring:v1:${key.replace(/A/g, "+")}`,
            "oc-keyring:v1:",
            key,
          ]),
        );
        let mine: string | null = null;
        try {
          mine = bytesToBase64Url(parseAccountKey(text));
        } catch {}
        const t = independent.parseAccountKey(text);
        expect(mine).toEqual(t && bytesToBase64Url(t));
      },
      { testCases: 200 },
    ));

  test("KR-43: hostile account deposits are opened alike", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const pairingKey = new Uint8Array(32).fill(0x91);
        const valid = secret(8);
        const key = tc.draw(
          gs.sampledFrom<unknown>([
            valid,
            valid,
            `${valid.slice(0, 42)}A`,
            `${valid}=`,
            valid.slice(1),
            `oc-keyring:v1:${valid}`,
            [valid],
            7,
            null,
          ]),
        );
        const v = tc.draw(
          gs.sampledFrom<unknown>([1, 1, 2, "1", true, null, undefined]),
        );
        const text = tc.draw(
          gs.sampledFrom([
            JSON.stringify({ v, key }),
            JSON.stringify({ v, key, keyring: "x" }),
            JSON.stringify({ v, keyring: key }),
            JSON.stringify([v, key]),
            `{"v":1,"key":${JSON.stringify(key)}`,
            `{"v":1,"v":${JSON.stringify(v)},"key":${JSON.stringify(key)}}`,
          ]),
        );
        let plaintext = new TextEncoder().encode(text);
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) {
          plaintext = new Uint8Array([...plaintext, 0xc3]);
        }
        const deposit = await encryptKeyring(pairingKey, plaintext);
        let mine: string | null = null;
        try {
          mine = bytesToBase64Url(
            await openAccountPairing(pairingKey, deposit),
          );
        } catch {}
        const t = await independent.openAccountPairing(pairingKey, deposit);
        expect(mine).toEqual(t && bytesToBase64Url(t));
      },
      { testCases: 400 },
    ));

  test("KR-42, KR-43: the independent client reads the vectors of an account", async () => {
    const { account, pairing } = vectors.keyring;
    const hex = (bytes: Uint8Array | null) =>
      bytes && Buffer.from(bytes).toString("hex");
    for (const { why, key, value } of account.keys) {
      expect(hex(independent.parseAccountKey(key)), why ?? key).toBe(value);
    }
    for (const { why, key } of account.keys_refused) {
      expect(independent.parseAccountKey(key), why).toBeNull();
    }
    const pairingKey = fromHex(pairing.key);
    for (const { why, deposit, value } of account.deposits) {
      expect(
        hex(await independent.openAccountPairing(pairingKey, fromHex(deposit))),
        why,
      ).toBe(value);
    }
    for (const { why, deposit } of account.deposits_refused) {
      expect(
        await independent.openAccountPairing(pairingKey, fromHex(deposit)),
        why,
      ).toBeNull();
    }
    const read = (address: string) => {
      const url = new URL(address);
      return independent.readPairingAddress(url.search, url.hash);
    };
    for (const {
      why,
      address,
      pairing_id,
      account: named,
    } of account.addresses) {
      const t = read(address);
      expect([t?.pairingId, t?.account], why ?? address).toEqual([
        pairing_id,
        named,
      ]);
    }
    for (const { why, address } of account.addresses_refused) {
      expect(read(address), why).toBeNull();
    }
  });

  test("KR-35, KR-36: the independent client reads the vectors' deposits and addresses", async () => {
    const { pairing } = vectors.keyring;
    const key = fromHex(pairing.key);
    for (const { why, deposit, keyring_id } of pairing.deposits) {
      const t = await independent.openPairing(key, fromHex(deposit));
      expect(t?.keyringId, why).toBe(keyring_id);
    }
    for (const { why, deposit } of pairing.deposits_refused) {
      expect(
        await independent.openPairing(key, fromHex(deposit)),
        why,
      ).toBeNull();
    }
    const read = (address: string) => {
      const url = new URL(address);
      return independent.readPairingAddress(url.search, url.hash);
    };
    for (const { address, pairing_id } of pairing.addresses) {
      expect(read(address)?.pairingId, address).toBe(pairing_id);
      expect(read(address)?.account, address).toBe(false);
    }
    for (const { why, address } of pairing.addresses_refused) {
      expect(read(address), why).toBeNull();
    }
    for (const address of pairing.not_pairing_addresses) {
      expect(read(address), address).toBeUndefined();
    }
  });
});
