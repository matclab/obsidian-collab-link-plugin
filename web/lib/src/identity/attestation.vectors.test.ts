// Attested names against the specification's vectors (docs/protocol/
// 06-identity.md, §6.10; docs/protocol/vectors.json,
// `identity.attestations`): entries of `attestations` read or ignored,
// each refused one for its one flaw; an object's date against an
// attestation's validity and a revocation; revocation lists read or
// refused.
import { describe, expect, test } from "vitest";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import {
  attests,
  readAttestationEntry,
  readRevocationBody,
} from "./attestation.js";

const v = vectors.identity.attestations;
const configured = new Set<string>(v.configured);

describe("attestations (ID-37)", () => {
  test("a valid entry is read with its fields", async () => {
    for (const entry of v.entries) {
      const read = await readAttestationEntry(
        entry.key,
        fromHex(entry.value),
        configured,
      );
      const { key, ...fields } = entry.attestation;
      expect(read && { ...read, key: toHex(read.key) }).toEqual({
        id: entry.key,
        key,
        ...fields,
      });
    }
  });

  test("an entry with a flaw is ignored", async () => {
    for (const entry of v.entries_refused) {
      expect(
        await readAttestationEntry(entry.key, fromHex(entry.value), configured),
        entry.why,
      ).toBeUndefined();
    }
  });

  test("no configured key: nothing is read", async () => {
    const [entry] = v.entries;
    expect(
      await readAttestationEntry(entry.key, fromHex(entry.value), new Set()),
    ).toBeUndefined();
  });

  test("a value that isn't bytes is ignored", async () => {
    const [entry] = v.entries;
    expect(
      await readAttestationEntry(entry.key, entry.value, configured),
    ).toBeUndefined();
  });
});

describe("an object's date (ID-39)", () => {
  test("is attested within the validity, before any revocation", async () => {
    const [entry] = v.entries;
    const attestation = await readAttestationEntry(
      entry.key,
      fromHex(entry.value),
      configured,
    );
    if (!attestation) throw new Error("the vector's entry is valid");
    for (const c of v.verdicts) {
      expect(
        attests(attestation, c.date, c.revoked_at ?? undefined),
        JSON.stringify(c),
      ).toBe(c.attested);
    }
  });
});

describe("revocation lists (ID-40)", () => {
  test("a valid body is read from its signed message", async () => {
    for (const body of v.revocation_bodies) {
      const list = await readRevocationBody(body.text, configured);
      expect(
        list && {
          issuedAt: list.issuedAt,
          revoked: Object.fromEntries(list.revoked),
        },
      ).toEqual({ issuedAt: body.issued_at, revoked: body.revoked });
    }
  });

  test("a body with a flaw is refused", async () => {
    for (const body of v.revocation_bodies_refused) {
      expect(
        await readRevocationBody(body.text, configured),
        body.why,
      ).toBeUndefined();
    }
  });
});
