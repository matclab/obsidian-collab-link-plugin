// Identity against the specification's vectors (docs/protocol/
// 06-identity.md, docs/protocol/vectors.json, section `identity`): the
// encoding, the key and its fingerprint, each kind's message to the byte,
// signed objects verified, unverified ones refused, keys and `identities`
// entries refused.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { fromHex, fromUtf16, toHex, vectors } from "../test-support/vectors.js";
import { encodeCanonical } from "./cbor.js";
import {
  formatShortFingerprint,
  isAcceptablePublicKey,
  publicKeyFingerprint,
} from "./keys.js";
import { messageOf } from "./message-of.js";
import {
  type KnownKey,
  knownKey,
  readIdentities,
  verify,
} from "./signature.js";

const { identity } = vectors;

/** The fields as an object holds them: `<name>_hex` are bytes. */
function fieldsOf(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) =>
      name.endsWith("_hex")
        ? [name.slice(0, -4), fromHex(value as string)]
        : name.endsWith("_utf16")
          ? [name.slice(0, -6), fromUtf16(value as string)]
          : [name, value],
    ),
  );
}

async function known(publicKey: string | null): Promise<KnownKey[]> {
  if (publicKey === null) return [];
  const key = await knownKey(fromHex(publicKey));
  // A key the specification refuses is still offered: verify must say no.
  return [
    key ?? {
      publicKey: fromHex(publicKey),
      fingerprint: await publicKeyFingerprint(fromHex(publicKey)),
    },
  ];
}

describe("identity, as the vectors say", () => {
  test("ID-1, ID-2: the encoding", () => {
    for (const { value, cbor } of identity.encoding) {
      expect(toHex(encodeCanonical(value)), JSON.stringify(value)).toBe(cbor);
    }
  });

  test("ID-5: the key's fingerprint and its short form", async () => {
    const fingerprint = await publicKeyFingerprint(
      fromHex(identity.key.public_key),
    );
    expect(toHex(fingerprint)).toBe(identity.key.fingerprint);
    expect(formatShortFingerprint(fingerprint)).toBe(identity.key.short);
  });

  test("§6.5, ID-15: each kind's message, to the byte; each object signed", async () => {
    const keys = await known(identity.key.public_key);
    for (const { kind, id, fields, message, sig } of identity.objects) {
      const build = (signer: Uint8Array) =>
        messageOf(
          { documentId: identity.document_id, signer },
          kind,
          id,
          fieldsOf(fields),
        );
      const built = await build(fromHex(identity.key.fingerprint));
      expect(built && toHex(built), `${kind} ${id}`).toBe(message);
      const by = await verify(fromHex(sig), keys, build);
      expect(by && toHex(by.fingerprint), `${kind} ${id}`).toBe(
        identity.key.fingerprint,
      );
    }
  });

  test("ID-6, ID-14 – ID-16: the unverified stay so", async () => {
    for (const u of identity.unverified) {
      const build = (signer: Uint8Array) =>
        messageOf(
          { documentId: u.document_id, signer },
          u.kind,
          u.id,
          fieldsOf(u.fields),
        );
      expect(
        await verify(fromHex(u.sig), await known(u.public_key), build),
        u.why,
      ).toBeUndefined();
    }
    for (const { why, public_key } of identity.keys_refused) {
      expect(isAcceptablePublicKey(fromHex(public_key)), why).toBe(false);
    }
  });

  test("ID-8: what a client reads of `identities`", async () => {
    const doc = new LoroDoc();
    const map = doc.getMap("identities");
    for (const { name, value } of identity.identities.entries) {
      map.set(name, fromHex(value));
    }
    doc.commit();
    expect(
      (await readIdentities(doc)).map((k) => toHex(k.fingerprint)),
    ).toEqual(identity.identities.read);
  });
});
