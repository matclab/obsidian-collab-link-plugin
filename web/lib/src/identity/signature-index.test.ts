// The signatures of a document, verified once each (phase 18, decision 10;
// docs/protocol/06-identity.md, ID-15 – ID-18; SG1, SG4, SG6): what is
// signed reads signed once verified, with its key's short fingerprint; a
// value changed afterwards reads unverified, at once; a key removed from
// `identities` unverifies what it signed, a key arriving later verifies
// it; one verification per object and value, none for a keystroke; a name
// under two keys is said; an object received live long after its date is
// said, by the reader's clock.
import { LoroDoc, type LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { AnnotationIndex } from "../annotations/annotation-index.js";
import { DecisionLog } from "../annotations/decisions.js";
import {
  draftAnnotation,
  draftReply,
  writeAnnotation,
  writeReply,
} from "../annotations/model.js";
import {
  draftVersion,
  registerPeers,
  writeVersion,
} from "../history/tables.js";
import { counters, resetCounters } from "../perf/counters.js";
import {
  type DocumentSigning,
  sealAnnotation,
  sealPeers,
  sealReply,
  sealVersion,
} from "./document-signing.js";
import { formatShortFingerprint, generateIdentityKey } from "./keys.js";
import { SignatureIndex } from "./signature-index.js";
import { type Signer, signerOf } from "./signature.js";

const DOC = "doc-1";
const DAY = 24 * 3600 * 1000;

async function setUp(now = () => 1_000_000) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour le monde");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const log = new DecisionLog();
  const annotations = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const signatures = new SignatureIndex({
    documentId: DOC,
    annotationsDoc,
    log,
    now,
  });
  const signer = await signerOf(await generateIdentityKey());
  const signing: DocumentSigning = {
    documentId: DOC,
    signer: async () => signer,
  };
  return {
    contentDoc,
    annotationsDoc,
    annotations,
    signatures,
    signer,
    signing,
    log,
  };
}

async function signedComment(
  s: Awaited<ReturnType<typeof setUp>>,
  author = "Alice",
  createdAt = 1_000,
  signing: DocumentSigning = s.signing,
) {
  const draft = draftAnnotation(s.contentDoc, {
    type: "comment",
    start: 0,
    end: 7,
    author,
    body: "?",
    createdAt,
  });
  writeAnnotation(
    s.annotationsDoc,
    draft,
    await sealAnnotation(signing, draft),
  );
  return draft.id;
}

const short = (signer: Signer) => formatShortFingerprint(signer.fingerprint);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("the signature index", () => {
  test("ID-15: signed once verified, with the short fingerprint; unsigned is unverified", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    const plain = draftAnnotation(s.contentDoc, {
      type: "deletion",
      start: 8,
      end: 10,
      author: "Bob",
      createdAt: 2,
    });
    writeAnnotation(s.annotationsDoc, plain);
    await s.signatures.idle();
    const view = s.signatures.current();
    expect(view.of("annotation", id)).toMatchObject({
      signed: true,
      short: short(s.signer),
    });
    expect(view.of("annotation", plain.id)).toEqual({ signed: false });
  });

  test("settled: not while a verification it started runs; once they ended", async () => {
    const s = await setUp();
    expect(s.signatures.current().settled).toBe(true);
    const id = await signedComment(s);
    const during = s.signatures.current();
    expect(during.settled).toBe(false);
    expect(during.of("annotation", id)).toEqual({ signed: false });
    await s.signatures.idle();
    const after = s.signatures.current();
    expect(after.settled).toBe(true);
    expect(after.of("annotation", id)).toMatchObject({ signed: true });
    // Nothing more to verify for a keystroke: still settled.
    s.contentDoc.getText("content").insert(0, "x");
    s.contentDoc.commit();
    expect(s.signatures.current().settled).toBe(true);
  });

  test("SG1: a signed field changed afterwards reads unverified, at once", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(true);
    const entry = s.annotationsDoc.getMap("annotations").get(id) as LoroMap;
    entry.set("body", "rewritten by a reviewer");
    s.annotationsDoc.commit();
    // Before any verification ends: never the old verdict.
    expect(s.signatures.current().of("annotation", id).signed).toBe(false);
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(false);
  });

  test("SG6: a key removed unverifies; a key arriving later verifies", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    const identities = s.annotationsDoc.getMap("identities");
    const [name] = [...identities.keys()];
    const key = identities.get(name as string) as Uint8Array;
    identities.delete(name as string);
    s.annotationsDoc.commit();
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(false);
    identities.set(name as string, key);
    s.annotationsDoc.commit();
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(true);
  });

  test("decision 10, SG4: one verification per object and value; none for a keystroke", async () => {
    const s = await setUp();
    await signedComment(s);
    await signedComment(s, "Alice", 2_000);
    resetCounters();
    await s.signatures.idle();
    s.signatures.current();
    expect(counters()["identity.verify"]).toBe(2);
    // Asked again, after other objects: the first two not again.
    await signedComment(s, "Alice", 3_000);
    await s.signatures.idle();
    s.signatures.current();
    expect(counters()["identity.verify"]).toBe(3);
    resetCounters();
    let told = 0;
    s.signatures.subscribe(() => told++);
    for (let i = 0; i < 20; i++) {
      s.contentDoc.getText("content").insert(0, "x");
      s.contentDoc.commit();
    }
    await s.signatures.idle();
    await Promise.resolve();
    expect(told).toBe(0);
    expect(counters()["identity.verify"] ?? 0).toBe(0);
    expect(counters()["signatures.compute"] ?? 0).toBe(0);
  });

  test("replies, versions and names in peers: each verified", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    const reply = draftReply(s.annotationsDoc, id, {
      author: "Bob",
      body: "!",
      createdAt: 5,
    });
    writeReply(s.annotationsDoc, reply, await sealReply(s.signing, reply));
    const version = draftVersion([], { name: "V1", author: "Alice", at: 6 });
    writeVersion(
      s.annotationsDoc,
      version,
      await sealVersion(s.signing, version),
    );
    registerPeers(
      s.annotationsDoc,
      ["42"],
      "Alice",
      await sealPeers(s.signing, ["42"], "Alice"),
    );
    registerPeers(s.annotationsDoc, ["43"], "Carol");
    await s.signatures.idle();
    const view = s.signatures.current();
    expect(view.of("reply", `${id}/${reply.id}`).signed).toBe(true);
    expect(view.of("version", version.id).signed).toBe(true);
    expect(view.of("peer", "42").signed).toBe(true);
    expect(view.of("peer", "43").signed).toBe(false);
  });

  test("ID-17: one name under two keys is said, on both", async () => {
    const s = await setUp();
    const other = await signerOf(await generateIdentityKey());
    const a = await signedComment(s, "Alice");
    const b = await signedComment(s, "Alice", 2_000, {
      documentId: DOC,
      signer: async () => other,
    });
    const c = await signedComment(s, "Bob", 3_000);
    await s.signatures.idle();
    const view = s.signatures.current();
    expect(view.of("annotation", a)).toMatchObject({
      signed: true,
      twoKeys: true,
    });
    expect(view.of("annotation", b)).toMatchObject({
      signed: true,
      twoKeys: true,
    });
    expect(view.of("annotation", c)).toMatchObject({
      signed: true,
      twoKeys: false,
    });
  });

  test("ID-42: the keys of a name, in the order of their fingerprints, on each; none for a name of one key", async () => {
    const s = await setUp();
    const other = await signerOf(await generateIdentityKey());
    const a = await signedComment(s, "Alice");
    const b = await signedComment(s, "Alice", 2_000, {
      documentId: DOC,
      signer: async () => other,
    });
    const c = await signedComment(s, "Bob", 3_000);
    await s.signatures.idle();
    const view = s.signatures.current();
    const keys = [s.signer, other]
      .map((signer) => ({
        fingerprint: hex(signer.fingerprint),
        short: short(signer),
      }))
      .sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
    expect(view.of("annotation", a)).toMatchObject({ nameKeys: keys });
    expect(view.of("annotation", b)).toMatchObject({ nameKeys: keys });
    expect(view.of("annotation", c)).not.toHaveProperty("nameKeys");
  });

  test("ID-42: a third key for a name changes the marks' version", async () => {
    const s = await setUp();
    const other = await signerOf(await generateIdentityKey());
    const third = await signerOf(await generateIdentityKey());
    await signedComment(s, "Alice");
    await signedComment(s, "Alice", 2_000, {
      documentId: DOC,
      signer: async () => other,
    });
    await s.signatures.idle();
    const before = s.signatures.current().version("annotation");
    // Not an annotation: only the keys of the name change on the cards.
    registerPeers(
      s.annotationsDoc,
      ["44"],
      "Alice",
      await sealPeers(
        { documentId: DOC, signer: async () => third },
        ["44"],
        "Alice",
      ),
    );
    await s.signatures.idle();
    const view = s.signatures.current();
    expect(view.of("peer", "44").signed).toBe(true);
    expect(view.version("annotation")).not.toBe(before);
  });

  test("ID-18, two clocks: received live more than 24 h after its date, said; the history isn't", async () => {
    let now = 50 * DAY;
    const s = await setUp(() => now);
    // In the history loaded at opening: never said, whatever its date.
    const old = await signedComment(s, "Alice", 10 * DAY);
    s.signatures.opened();
    // Live, its author's clock 25 h behind the reader's: said.
    const late = await signedComment(s, "Alice", now - (25 * DAY) / 24);
    // Live, 23 h behind: not said.
    const recent = await signedComment(s, "Alice", now - (23 * DAY) / 24);
    // Live, its author's clock ahead of the reader's: not said either.
    const ahead = await signedComment(s, "Alice", now + 5 * DAY);
    await s.signatures.idle();
    now += DAY; // the reader's clock moves on: nothing changes
    const view = s.signatures.current();
    expect(view.of("annotation", old)).not.toHaveProperty("late");
    expect(view.of("annotation", late)).toMatchObject({
      late: { dated: 50 * DAY - (25 * DAY) / 24, received: 50 * DAY },
    });
    expect(view.of("annotation", recent)).not.toHaveProperty("late");
    expect(view.of("annotation", ahead)).not.toHaveProperty("late");
  });

  test("case 8: a verification that ends after a change doesn't apply to the new value", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    s.signatures.current(); // starts the verification of the signed value
    const entry = s.annotationsDoc.getMap("annotations").get(id) as LoroMap;
    entry.set("author", "Mallory");
    s.annotationsDoc.commit();
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(false);
    // Changed back: the verification already made counts, none more.
    resetCounters();
    entry.set("author", "Alice");
    s.annotationsDoc.commit();
    await s.signatures.idle();
    expect(s.signatures.current().of("annotation", id).signed).toBe(true);
    expect(counters()["identity.verify"] ?? 0).toBe(0);
  });

  test("the same view while nothing changed", async () => {
    const s = await setUp();
    await signedComment(s);
    await s.signatures.idle();
    expect(s.signatures.current()).toBe(s.signatures.current());
  });

  // Security review of 18g: a reply copying a signed reply's id (and its
  // sig) would have shared its verdict.
  test("ID-10: replies sharing an id are all unverified", async () => {
    const s = await setUp();
    const id = await signedComment(s);
    const reply = draftReply(s.annotationsDoc, id, {
      author: "Alice",
      body: "oui",
      createdAt: 5,
    });
    const seal = await sealReply(s.signing, reply);
    writeReply(s.annotationsDoc, reply, seal);
    await s.signatures.idle();
    expect(s.signatures.current().of("reply", `${id}/${reply.id}`).signed).toBe(
      true,
    );
    // Mallory appends her own text under the same id, with Alice's sig.
    writeReply(
      s.annotationsDoc,
      { ...reply, fields: { ...reply.fields, body: "non, rien" } },
      seal,
    );
    await s.signatures.idle();
    expect(s.signatures.current().of("reply", `${id}/${reply.id}`).signed).toBe(
      false,
    );
  });
});
