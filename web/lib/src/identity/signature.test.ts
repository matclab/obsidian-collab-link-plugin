// Signing and verifying (docs/protocol/06-identity.md, ID-7, ID-8, ID-14 –
// ID-16; SG1, SG3): a signed object verifies as it was signed, and no
// longer once a signed field changes, nor as another object, kind or
// document; `identities` is read strictly; a short fingerprint shared by
// two keys still finds the one that signed.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateIdentityKey } from "./keys.js";
import {
  annotationMessage,
  decisionMessage,
  peerMessage,
  presenceMessage,
  replyMessage,
  versionMessage,
} from "./messages.js";
import {
  type KnownKey,
  addIdentity,
  knownKey,
  readIdentities,
  sign,
  signerOf,
  verify,
} from "./signature.js";

const DOC = "doc-1";
const fields = {
  type: "comment",
  author: "Alice",
  createdAt: 1_792_000_000_000,
  body: "Plutôt « demain ».",
};

const annotation =
  (doc: string, id: string, f: Record<string, unknown> = fields) =>
  (signer: Uint8Array) =>
    annotationMessage({ documentId: doc, signer }, id, f as never);

describe("signing and verifying", () => {
  test("ID-15: signed, as signed; changed, unverified (SG1, SG3)", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const known: KnownKey[] = [signer];
    const sig = await sign(signer, annotation(DOC, "a1"));
    expect(sig).toHaveLength(72);
    expect(
      (await verify(sig, known, annotation(DOC, "a1")))?.fingerprint,
    ).toEqual(signer.fingerprint);
    for (const [what, build] of [
      ["another author", annotation(DOC, "a1", { ...fields, author: "Bob" })],
      ["another body", annotation(DOC, "a1", { ...fields, body: "x" })],
      ["a note added", annotation(DOC, "a1", { ...fields, note: "n" })],
      ["another date", annotation(DOC, "a1", { ...fields, createdAt: 1 })],
      ["another object", annotation(DOC, "a2")],
      ["another document", annotation("doc-2", "a1")],
      [
        "another kind",
        (s: Uint8Array) =>
          replyMessage({ documentId: DOC, signer: s }, "a1", {
            annotation: "a1",
            author: "Alice",
            createdAt: fields.createdAt,
            body: fields.body,
          }),
      ],
    ] as const) {
      expect(await verify(sig, known, build), what).toBeUndefined();
    }
  });

  test("ID-15: the key is found by its short fingerprint, even shared", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const other = await signerOf(await generateIdentityKey());
    // A key made up to share the signer's 8 first bytes.
    const lookalike: KnownKey = {
      publicKey: other.publicKey,
      fingerprint: Uint8Array.from([
        ...signer.fingerprint.slice(0, 8),
        ...other.fingerprint.slice(8),
      ]),
    };
    const sig = await sign(signer, annotation(DOC, "a1"));
    const found = await verify(sig, [lookalike, signer], annotation(DOC, "a1"));
    expect(found?.publicKey).toEqual(signer.publicKey);
    expect(
      await verify(sig, [lookalike], annotation(DOC, "a1")),
    ).toBeUndefined();
    expect(await verify(sig, [other], annotation(DOC, "a1"))).toBeUndefined();
    expect(await verify(sig, [], annotation(DOC, "a1"))).toBeUndefined();
  });

  test("ID-7, ID-16: a malformed sig is unverified, never an error", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const sig = await sign(signer, annotation(DOC, "a1"));
    for (const bad of [
      sig.slice(1),
      new Uint8Array([...sig, 0]),
      "sig",
      null,
      undefined,
      Array.from(sig),
    ]) {
      expect(
        await verify(bad, [signer], annotation(DOC, "a1")),
      ).toBeUndefined();
    }
  });

  test("ID-14: an object whose fields aren't of their type can't be signed nor verified", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const sig = await sign(signer, annotation(DOC, "a1"));
    for (const changed of [
      { ...fields, createdAt: 1.5 },
      { ...fields, createdAt: "1" },
      { ...fields, author: 3 },
      { ...fields, body: 3 },
      { ...fields, author: "\ud800" },
      { ...fields, change: "not bytes" },
    ]) {
      await expect(
        sign(signer, annotation(DOC, "a1", changed)),
      ).rejects.toThrow();
      expect(
        await verify(sig, [signer], annotation(DOC, "a1", changed)),
      ).toBeUndefined();
    }
  });

  test("§6.5: every kind signs and verifies its own message", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const context = (s: Uint8Array) => ({ documentId: DOC, signer: s });
    const builders = [
      (s: Uint8Array) =>
        decisionMessage(context(s), "p1", {
          annotation: "a1",
          decision: "accept",
          author: "Alice",
          change: new Uint8Array([1, 2]),
        }),
      (s: Uint8Array) =>
        versionMessage(context(s), "v1", {
          name: "Relue",
          author: "Alice",
          at: 5,
          frontiers: [
            { peer: "12", counter: 3 },
            { peer: "7", counter: 0 },
          ],
        }),
      (s: Uint8Array) =>
        peerMessage(context(s), "18446744073709551615", "Alice"),
      (s: Uint8Array) =>
        presenceMessage(context(s), "ab".repeat(16), {
          seq: 4,
          name: "Alice",
          color: "#d1495b",
        }),
    ];
    for (const build of builders) {
      const sig = await sign(signer, build);
      expect(await verify(sig, [signer], build)).toBeDefined();
    }
    // A version whose frontiers aren't D-20's, a peer id out of range.
    for (const build of [
      (s: Uint8Array) =>
        versionMessage(context(s), "v1", {
          name: "x",
          author: "a",
          at: 5,
          frontiers: [{ peer: "x", counter: 1 }],
        }),
      (s: Uint8Array) => peerMessage(context(s), "18446744073709551616", "a"),
    ]) {
      await expect(sign(signer, build)).rejects.toThrow();
    }
  });

  test("ID-8: identities are read strictly", async () => {
    const signer = await signerOf(await generateIdentityKey());
    const other = await signerOf(await generateIdentityKey());
    const doc = new LoroDoc();
    expect(addIdentity(doc, signer)).toBe(true);
    expect(addIdentity(doc, signer)).toBe(false);
    const table = doc.getMap("identities");
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    // Under another key's fingerprint, too short, small order, not bytes.
    table.set(hex(other.fingerprint), signer.publicKey);
    table.set("ab".repeat(32), new Uint8Array(31));
    const zero = new Uint8Array(32);
    table.set(
      hex(new Uint8Array(await crypto.subtle.digest("SHA-256", zero))),
      zero,
    );
    table.set("cd".repeat(32), "text");
    table.set("not hex", signer.publicKey);
    doc.commit();
    const read = await readIdentities(doc);
    expect(read.map((k) => hex(k.fingerprint))).toEqual([
      hex(signer.fingerprint),
    ]);
    // A presence's key: acceptable, or nothing.
    expect(await knownKey(signer.publicKey)).toEqual({
      publicKey: signer.publicKey,
      fingerprint: signer.fingerprint,
    });
    expect(await knownKey(zero)).toBeUndefined();
    expect(await knownKey("x")).toBeUndefined();
  });
});
