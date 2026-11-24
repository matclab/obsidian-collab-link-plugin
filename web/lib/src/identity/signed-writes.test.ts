// Writing signed objects (docs/protocol/06-identity.md, ID-9 – ID-12; SG5):
// drafted at once, signed, then written — the object, its sig, and the
// signer's key in `identities` in one commit; read back, each verifies as
// signed by that key, and its message is built from what is read. Without
// a seal, written as before.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  draftAnnotation,
  draftReply,
  readAnnotationEntry,
  writeAnnotation,
  writeReply,
} from "../annotations/model.js";
import {
  draftVersion,
  peerSignature,
  registerPeers,
  writeVersion,
} from "../history/tables.js";
import { generateIdentityKey } from "./keys.js";
import {
  annotationMessage,
  peerMessage,
  replyMessage,
  versionMessage,
} from "./messages.js";
import {
  type Signer,
  readIdentities,
  sign,
  signerOf,
  verify,
} from "./signature.js";

const DOC = "d-1";

function docs() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour le monde");
  contentDoc.commit();
  return { contentDoc, annotationsDoc: new LoroDoc() };
}

/** The commits `act` makes on `doc`. */
function commits(doc: LoroDoc, act: () => void): number {
  let made = 0;
  const unsubscribe = doc.subscribePreCommit(() => {
    made++;
  });
  try {
    act();
  } finally {
    unsubscribe();
  }
  return made;
}

async function signer(): Promise<Signer> {
  return signerOf(await generateIdentityKey());
}

describe("signed writes", () => {
  test("ID-12: an annotation, its sig and the key, in one commit; it verifies", async () => {
    const { contentDoc, annotationsDoc } = docs();
    const key = await signer();
    const draft = draftAnnotation(contentDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "Alice",
      body: "Bonsoir ?",
      note: "",
      createdAt: 1000,
    });
    const sig = await sign(key, (s) =>
      annotationMessage({ documentId: DOC, signer: s }, draft.id, draft.fields),
    );
    // Typed meanwhile: the anchors follow (cas 9).
    contentDoc.getText("content").insert(0, "« ");
    contentDoc.commit();
    expect(
      commits(annotationsDoc, () => {
        writeAnnotation(annotationsDoc, draft, { sig, signer: key });
      }),
    ).toBe(1);
    const read = readAnnotationEntry(annotationsDoc, draft.id);
    expect(read?.sig).toEqual(sig);
    const known = await readIdentities(annotationsDoc);
    expect(
      await verify(read?.sig, known, (s) =>
        annotationMessage(
          { documentId: DOC, signer: s },
          draft.id,
          read?.fields ?? ({} as never),
        ),
      ),
    ).toBeDefined();
  });

  test("without a seal, as before: no sig, no key", () => {
    const { contentDoc, annotationsDoc } = docs();
    const draft = draftAnnotation(contentDoc, {
      type: "deletion",
      start: 0,
      end: 3,
      author: "Bob",
    });
    writeAnnotation(annotationsDoc, draft);
    expect(readAnnotationEntry(annotationsDoc, draft.id)?.sig).toBeUndefined();
    expect(annotationsDoc.getMap("identities").size).toBe(0);
  });

  test("ID-10, ID-12: a reply carries its id and sig, and verifies", async () => {
    const { contentDoc, annotationsDoc } = docs();
    const key = await signer();
    const annotation = draftAnnotation(contentDoc, {
      type: "comment",
      start: 0,
      end: 3,
      author: "Bob",
      body: "?",
    });
    writeAnnotation(annotationsDoc, annotation);
    const draft = draftReply(annotationsDoc, annotation.id, {
      author: "Alice",
      body: "Oui.",
      createdAt: 2000,
    });
    expect(draft.id).toMatch(/^[0-9a-f-]{36}$/);
    const build = (s: Uint8Array) =>
      replyMessage({ documentId: DOC, signer: s }, draft.id, {
        annotation: annotation.id,
        ...draft.fields,
      });
    const sig = await sign(key, build);
    expect(
      commits(annotationsDoc, () => {
        writeReply(annotationsDoc, draft, { sig, signer: key });
      }),
    ).toBe(1);
    const [reply] =
      readAnnotationEntry(annotationsDoc, annotation.id)?.replies ?? [];
    expect(reply?.id).toBe(draft.id);
    expect(reply?.sig).toEqual(sig);
    expect(
      await verify(reply?.sig, await readIdentities(annotationsDoc), build),
    ).toBeDefined();
  });

  test("ID-12: a version and a name in `peers`, signed in one commit each", async () => {
    const { annotationsDoc } = docs();
    const key = await signer();
    const draft = draftVersion([{ peer: "12", counter: 4 }], {
      name: "  Relue  ",
      author: "Alice",
      at: 3000,
    });
    expect(draft.fields.name).toBe("Relue");
    const build = (s: Uint8Array) =>
      versionMessage({ documentId: DOC, signer: s }, draft.id, draft.fields);
    const sig = await sign(key, build);
    expect(
      commits(annotationsDoc, () => {
        writeVersion(annotationsDoc, draft, { sig, signer: key });
      }),
    ).toBe(1);
    const entry = annotationsDoc.getMap("versions").get(draft.id);
    expect((entry as { get(k: string): unknown }).get("sig")).toEqual(sig);
    expect(
      await verify(sig, await readIdentities(annotationsDoc), build),
    ).toBeDefined();

    const peerSig = await sign(key, (s) =>
      peerMessage({ documentId: DOC, signer: s }, "77", "Alice"),
    );
    expect(
      commits(annotationsDoc, () => {
        registerPeers(
          annotationsDoc,
          ["77"],
          "Alice",
          new Map([["77", { sig: peerSig, signer: key }]]),
        );
      }),
    ).toBe(1);
    expect(peerSignature(annotationsDoc, "77")).toEqual(peerSig);
    // Registered again under the same name and signature: nothing written.
    expect(
      commits(annotationsDoc, () => {
        registerPeers(
          annotationsDoc,
          ["77"],
          "Alice",
          new Map([["77", { sig: peerSig, signer: key }]]),
        );
      }),
    ).toBe(0);
  });
});
