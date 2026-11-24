// @vitest-environment node
//
// Phase 18g (docs/protocol/06-identity.md; AGENTS.md §1.5): whether an
// object reads « signed » is decided by every client of a document, maybe
// of different makers. The official client against the independent one
// (written from the specification alone): the same encoding, or the same
// refusal, of any value; the same verdict — signed by the same key, or
// unverified — on hostile objects: fields of every type, dates not
// integers, lone surrogates, signatures altered or cut, other keys,
// keys of small order; and the vectors read alike.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import {
  type KnownKey,
  type SignedKind,
  encodeCanonical,
  generateIdentityKey,
  messageOf,
  publicKeyFingerprint,
  readIdentities,
  sign,
  signerOf,
  verify,
} from "../../lib/src/index.js";
import {
  fromHex,
  fromUtf16,
  vectors,
} from "../../lib/src/test-support/vectors.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/identity.mjs");
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const KINDS: SignedKind[] = [
  "annotation",
  "reply",
  "decision",
  "version",
  "peer",
  "presence",
  "subscription",
];

/** A value of any type an object may hold. */
function anyValue(tc: TC): unknown {
  return tc.draw(
    gs.sampledFrom<unknown>([
      "",
      "Alice",
      "\ud800",
      "a\udc00",
      "😀",
      "18446744073709551615",
      "18446744073709551616",
      "7",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      true,
      null,
      undefined,
      new Uint8Array([1, 2]),
      [],
      [{ peer: "7", counter: 0 }],
      [{ peer: "x", counter: 0 }],
      [{ peer: "7", counter: -1 }],
      { a: 1 },
    ]),
  );
}

/** An object's fields, mostly well formed, one thing changed sometimes. */
function fieldsFor(tc: TC, kind: SignedKind): Record<string, unknown> {
  const good: Record<SignedKind, Record<string, unknown>> = {
    annotation: {
      type: "comment",
      author: "Alice",
      createdAt: 1_792_000_000_000,
      body: "b",
      ...(tc.draw(gs.booleans()) && { note: "n" }),
      ...(tc.draw(gs.booleans()) && { change: new Uint8Array([5, 6]) }),
    },
    reply: { annotation: "a1", author: "Alice", createdAt: 3, body: "r" },
    decision: {
      annotation: "a1",
      decision: "accept",
      author: "Alice",
      ...(tc.draw(gs.booleans()) && { change: new Uint8Array([7]) }),
    },
    version: {
      name: "V",
      author: "Alice",
      at: 9,
      frontiers: [{ peer: "12", counter: 3 }],
    },
    peer: { name: "Alice" },
    presence: { seq: 2, name: "Alice", color: "#d1495b" },
    subscription: {
      endpoint: "https://fcm.googleapis.com/wp/a",
      p256dh: new Uint8Array(65).fill(4),
      auth: new Uint8Array(16).fill(1),
      vapid: new Uint8Array(32).fill(2),
      createdAt: 4,
    },
  };
  const fields = { ...good[kind] };
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) === 0) {
    const names = Object.keys(fields);
    const name = tc.draw(
      gs.sampledFrom([...names, "body", "note", "change", "auth"]),
    );
    fields[name] = anyValue(tc);
  }
  return fields;
}

describe("identity, decided alike by the official and the independent client", () => {
  test("ID-1 – ID-3: any value is encoded alike, or refused by both", () =>
    hegel.test(
      (tc: TC) => {
        const value = tc.draw(gs.booleans())
          ? anyValue(tc)
          : {
              [tc.draw(gs.sampledFrom(["a", "b", "aa", "é", "\ud800", ""]))]:
                anyValue(tc),
              [tc.draw(gs.sampledFrom(["z", "ab", "B", "😀"]))]: anyValue(tc),
            };
        let mine: string | null = null;
        try {
          mine = hex(encodeCanonical(value as never));
        } catch {}
        let theirs: string | null = null;
        try {
          theirs = hex(independent.canonical(value));
        } catch {}
        expect(mine).toBe(theirs);
      },
      { testCases: 400 },
    ));

  test("ID-15, ID-16: hostile objects get the same verdict", () =>
    hegel.testAsync(
      async (tc: TC) => {
        const key = await signerOf(await generateIdentityKey());
        const kind = tc.draw(gs.sampledFrom(KINDS));
        const id =
          kind === "peer"
            ? tc.draw(gs.sampledFrom(["7", "18446744073709551616", "x"]))
            : tc.draw(gs.sampledFrom(["o1", "o2", ""]));
        const doc = tc.draw(gs.sampledFrom(["d1", "d2"]));
        const signedFields = fieldsFor(tc, kind);
        const build =
          (d: string, f: Record<string, unknown>) => (signer: Uint8Array) =>
            messageOf({ documentId: d, signer }, kind, id, f);
        let sig: Uint8Array;
        try {
          sig = await sign(key, build("d1", signedFields));
        } catch {
          sig = new Uint8Array(72);
        }
        // What the reader holds: maybe changed since.
        const shown =
          tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
            ? signedFields
            : fieldsFor(tc, kind);
        switch (tc.draw(gs.integers({ minValue: 0, maxValue: 7 }))) {
          case 0:
            sig = sig.slice(
              0,
              tc.draw(gs.integers({ minValue: 0, maxValue: 71 })),
            );
            break;
          case 1: {
            const at = tc.draw(gs.integers({ minValue: 0, maxValue: 71 }));
            sig = sig.slice();
            sig[at] = (sig[at] as number) ^ 1;
            break;
          }
          default:
        }
        // Known keys: the signer's, perhaps not; another; a key of small
        // order.
        const other = await signerOf(await generateIdentityKey());
        const keys: Uint8Array[] = [];
        if (tc.draw(gs.booleans())) keys.push(other.publicKey);
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0) {
          keys.push(key.publicKey);
        }
        if (tc.draw(gs.booleans()))
          keys.push(new Uint8Array(32).fill(0).fill(1, 0, 1));
        const known: KnownKey[] = await Promise.all(
          keys.map(async (publicKey) => ({
            publicKey,
            fingerprint: await publicKeyFingerprint(publicKey),
          })),
        );
        const mine = await verify(sig, known, build(doc, shown));
        const theirs = independent.signedBy(sig, keys, kind, doc, id, shown);
        expect(mine ? hex(mine.fingerprint) : null).toBe(theirs);
      },
      { testCases: 300 },
    ));

  test("the vectors: the independent client verifies and refuses as they say", async () => {
    const { identity } = vectors;
    const fieldsOf = (fields: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(fields).map(([n, v]) =>
          n.endsWith("_hex")
            ? [n.slice(0, -4), fromHex(v as string)]
            : n.endsWith("_utf16")
              ? [n.slice(0, -6), fromUtf16(v as string)]
              : [n, v],
        ),
      );
    const pk = fromHex(identity.key.public_key);
    for (const o of identity.objects) {
      expect(
        independent.signedBy(
          fromHex(o.sig),
          [pk],
          o.kind,
          identity.document_id,
          o.id,
          fieldsOf(o.fields),
        ),
        `${o.kind} ${o.id}`,
      ).toBe(identity.key.fingerprint);
    }
    for (const u of identity.unverified) {
      expect(
        independent.signedBy(
          fromHex(u.sig),
          u.public_key === null ? [] : [fromHex(u.public_key)],
          u.kind,
          u.document_id,
          u.id,
          fieldsOf(u.fields),
        ),
        u.why,
      ).toBeNull();
    }
    const doc = new LoroDoc();
    for (const { name, value } of identity.identities.entries) {
      doc.getMap("identities").set(name, fromHex(value));
    }
    doc.commit();
    expect(
      independent
        .identities(doc)
        .map((k: Uint8Array) => hex(independent.fingerprint(k))),
    ).toEqual(identity.identities.read);
    expect((await readIdentities(doc)).map((k) => hex(k.fingerprint))).toEqual(
      identity.identities.read,
    );
  });
});
