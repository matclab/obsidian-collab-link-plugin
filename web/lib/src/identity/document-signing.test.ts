// Seals of a document's objects (docs/protocol/06-identity.md; analysis
// 18g): made with the key of the moment, for this document; none when
// there is no key or signing fails; a decision's key goes into the
// annotations doc, committed, before its record is signed.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { draftAnnotation, writeAnnotation } from "../annotations/model.js";
import { ATTESTATIONS } from "./attestation.js";
import {
  decisionSealer,
  presenceSealer,
  sealAnnotation,
  sealPeers,
} from "./document-signing.js";
import { generateIdentityKey } from "./keys.js";
import {
  annotationMessage,
  decisionMessage,
  presenceMessage,
} from "./messages.js";
import { readIdentities, signerOf, verify } from "./signature.js";

async function signing(documentId = "d1") {
  const signer = await signerOf(await generateIdentityKey());
  return { documentId, signer: async () => signer, key: signer };
}

describe("a document's seals", () => {
  test("an annotation's seal verifies for this document only", async () => {
    const s = await signing();
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "deletion",
      start: 0,
      end: 1,
      author: "A",
      createdAt: 1,
    });
    const seal = await sealAnnotation(s, draft);
    expect(seal?.signer).toBe(s.key);
    const build = (doc: string) => (signer: Uint8Array) =>
      annotationMessage({ documentId: doc, signer }, draft.id, draft.fields);
    expect(await verify(seal?.sig, [s.key], build("d1"))).toBeDefined();
    expect(await verify(seal?.sig, [s.key], build("d2"))).toBeUndefined();
  });

  test("no key, or a key that fails: no seal", async () => {
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "deletion",
      start: 0,
      end: 1,
      author: "A",
      createdAt: 1.5,
    });
    expect(await sealAnnotation(undefined, draft)).toBeUndefined();
    expect(
      await sealAnnotation(
        { documentId: "d", signer: async () => undefined },
        draft,
      ),
    ).toBeUndefined();
    // A date not an integer: unsignable (ID-14).
    expect(await sealAnnotation(await signing(), draft)).toBeUndefined();
    const failing = {
      documentId: "d",
      signer: async () => {
        throw new Error("locked");
      },
    };
    expect(
      await sealAnnotation(failing, {
        ...draft,
        fields: { ...draft.fields, createdAt: 1 },
      }),
    ).toBeUndefined();
  });

  test("ID-12: a decision's key is committed in the annotations doc before it is signed", async () => {
    const s = await signing();
    const annotationsDoc = new LoroDoc();
    const proposal = {
      proposalId: "p1",
      annotationId: "a1",
      decision: "reject" as const,
      author: "A",
    };
    const sig = await decisionSealer(s, annotationsDoc)(proposal);
    const known = await readIdentities(annotationsDoc);
    expect(known).toHaveLength(1);
    expect(annotationsDoc.getPendingTxnLength()).toBe(0);
    expect(
      await verify(sig, known, (signer) =>
        decisionMessage({ documentId: "d1", signer }, "p1", {
          annotation: "a1",
          decision: "reject",
          author: "A",
        }),
      ),
    ).toBeDefined();
    await expect(
      decisionSealer(
        { documentId: "d1", signer: async () => undefined },
        annotationsDoc,
      )(proposal),
    ).rejects.toThrow();
  });

  test("ID-11: a presence's seal carries its key", async () => {
    const s = await signing();
    const state = { key: "ab".repeat(16), seq: 3, name: "A", color: "#d1495b" };
    const sealed = await presenceSealer(s)(state);
    expect(sealed?.pk).toEqual(s.key.publicKey);
    const { key, ...fields } = state;
    expect(
      await verify(sealed?.sig, [s.key], (signer) =>
        presenceMessage({ documentId: "d1", signer }, key, fields),
      ),
    ).toBeDefined();
  });
});

// AT2, ID-38: the attestation of the key that signed, and only of it,
// goes with the object, in its commit; a name in `peers` takes none.
describe("an attestation with the object", () => {
  test("AT2: the signer's own, written in the object's commit", async () => {
    const s = await signing();
    const envelope = new Uint8Array([0xa3, 1, 2]);
    const asked: string[] = [];
    const withAttestation = {
      ...s,
      attestation: (publicKey: Uint8Array) => {
        asked.push(Buffer.from(publicKey).toString("hex"));
        return envelope;
      },
    };
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "comment",
      start: 0,
      end: 1,
      author: "A",
      body: "?",
      createdAt: 1,
    });
    const seal = await sealAnnotation(withAttestation, draft);
    expect(asked).toEqual([Buffer.from(s.key.publicKey).toString("hex")]);
    expect(seal?.attestation).toBe(envelope);
    const doc = new LoroDoc();
    const commits: number[] = [];
    doc.subscribe(() => commits.push(doc.getMap(ATTESTATIONS).size));
    writeAnnotation(doc, draft, seal);
    expect(commits).toEqual([1]);
    expect([...doc.getMap(ATTESTATIONS).values()]).toEqual([envelope]);
    const peers = await sealPeers(withAttestation, ["7"], "A");
    expect(peers.get("7")?.attestation).toBeUndefined();
  });

  test("none to give: the object is written signed, without one", async () => {
    const s = await signing();
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "comment",
      start: 0,
      end: 1,
      author: "A",
      body: "?",
      createdAt: 1,
    });
    const seal = await sealAnnotation(
      { ...s, attestation: () => undefined },
      draft,
    );
    expect(seal?.sig).toBeInstanceOf(Uint8Array);
    expect(seal?.attestation).toBeUndefined();
  });
});

// Decision 20: what a person writes under their name waits for the
// question, if any; a name in `peers` and the presence never do.
describe("the question before signing", () => {
  test("annotations, replies and versions wait for it; peers and presence don't", async () => {
    const s = await signing();
    let open = () => {};
    let asked = 0;
    const gated = {
      ...s,
      beforeSigning: () => {
        asked += 1;
        return new Promise<void>((resolve) => {
          open = resolve;
        });
      },
    };
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "comment",
      start: 0,
      end: 1,
      author: "A",
      body: "?",
      createdAt: 1,
    });
    let sealed = false;
    const sealing = sealAnnotation(gated, draft).then((seal) => {
      sealed = true;
      return seal;
    });
    await Promise.resolve();
    expect(asked).toBe(1);
    expect(sealed).toBe(false);
    open();
    expect((await sealing)?.sig).toBeInstanceOf(Uint8Array);
    await sealPeers(gated, ["7"], "A");
    await presenceSealer(gated)({ key: "k", seq: 1, name: "A", color: "#000" });
    expect(asked).toBe(1);
  });

  // Analysis 18o.2, found end to end: an object held by the question is
  // dated when it is signed — no one has seen it before —, not when it
  // was drafted: else it is dated before the attestation the sign-in
  // brings, and only signed (ID-39).
  test("an object held by the question is dated when it is signed", async () => {
    const s = await signing();
    let open = () => {};
    let clock = 1_000;
    const gated = {
      ...s,
      now: () => clock,
      beforeSigning: () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    };
    const content = new LoroDoc();
    content.getText("content").insert(0, "abc");
    const draft = draftAnnotation(content, {
      type: "comment",
      start: 0,
      end: 1,
      author: "A",
      body: "?",
      createdAt: 1_000,
    });
    const sealing = sealAnnotation(gated, draft);
    await Promise.resolve();
    clock = 9_000;
    open();
    const seal = await sealing;

    expect(draft.fields.createdAt).toBe(9_000);
    // Signed as dated: the fields written are the fields signed.
    expect(
      await verify(seal?.sig, [s.key], (signer) =>
        annotationMessage(
          { documentId: s.documentId, signer },
          draft.id,
          draft.fields,
        ),
      ),
    ).toBeDefined();
  });
});
