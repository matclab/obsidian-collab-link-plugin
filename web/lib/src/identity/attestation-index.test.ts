// Attested names in the signature index, by example (docs/protocol/
// 06-identity.md, ID-37 – ID-40; analysis 18k): what the property against
// a model doesn't draw — replies and versions by their dates, a presence
// judged when it is received, decisions and names in `peers` never
// attested, other bytes under an attestation's key, no key configured.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { DecisionLog } from "../annotations/decisions.js";
import {
  draftAnnotation,
  draftReply,
  writeAnnotation,
  writeReply,
} from "../annotations/model.js";
import { sha256 } from "../annotations/sha256.js";
import {
  draftVersion,
  registerPeers,
  writeVersion,
} from "../history/tables.js";
import type { RemotePresence } from "../presence/presence.js";
import { ATTESTATIONS, addAttestation } from "./attestation.js";
import { encodeCanonical } from "./cbor.js";
import {
  type DocumentSigning,
  presenceSealer,
  sealAnnotation,
  sealPeers,
  sealReply,
  sealVersion,
} from "./document-signing.js";
import { generateIdentityKey, signBytes } from "./keys.js";
import { SignatureIndex } from "./signature-index.js";
import { type Signer, signerOf } from "./signature.js";

const DOC = "doc-1";
const DAY = 24 * 3600;
const ISSUED = 1_800_000_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function setUp() {
  const content = new LoroDoc();
  content.getText("content").insert(0, "Bonjour le monde");
  content.commit();
  const doc = new LoroDoc();
  const gateway = await signerOf(await generateIdentityKey());
  const person = await signerOf(await generateIdentityKey());
  const signing: DocumentSigning = {
    documentId: DOC,
    signer: async () => person,
  };
  const msg = encodeCanonical({
    ctx: "oc-attestation/v1",
    issuer: "https://idp.test",
    sub: "ada",
    name: "Ada Lovelace",
    email: "ada@example.org",
    key: person.publicKey,
    issuedAt: ISSUED,
    expiresAt: ISSUED + 30 * DAY,
  });
  const envelope = encodeCanonical({
    key: gateway.publicKey,
    msg,
    sig: await signBytes(gateway.privateKey, msg),
  });
  const configured = new Set([hex(sha256(gateway.publicKey))]);
  return { content, doc, gateway, person, signing, envelope, configured };
}

type SetUp = Awaited<ReturnType<typeof setUp>>;

async function comment(s: SetUp, createdAt: number) {
  const draft = draftAnnotation(s.content, {
    type: "comment",
    start: 0,
    end: 7,
    author: "pseudonym",
    body: "?",
    createdAt,
  });
  writeAnnotation(s.doc, draft, await sealAnnotation(s.signing, draft));
  return draft.id;
}

function index(s: SetUp, options: { keys?: boolean } = {}) {
  return new SignatureIndex({
    documentId: DOC,
    annotationsDoc: s.doc,
    log: new DecisionLog(),
    ...(options.keys !== false && { attestationKeys: s.configured }),
  });
}

const within = (ISSUED + DAY) * 1000;

describe("attested names", () => {
  test("ID-39: replies and versions by their dates; names in peers never", async () => {
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    const id = await comment(s, within);
    const reply = draftReply(s.doc, id, {
      author: "pseudonym",
      body: "!",
      createdAt: within,
    });
    writeReply(s.doc, reply, await sealReply(s.signing, reply));
    const early = draftReply(s.doc, id, {
      author: "pseudonym",
      body: "early",
      createdAt: ISSUED * 1000 - 1,
    });
    writeReply(s.doc, early, await sealReply(s.signing, early));
    const version = draftVersion([], { name: "V1", author: "p", at: within });
    writeVersion(s.doc, version, await sealVersion(s.signing, version));
    registerPeers(s.doc, ["42"], "p", await sealPeers(s.signing, ["42"], "p"));
    s.doc.commit();
    const signatures = index(s);
    await signatures.idle();
    const view = signatures.current();
    const name = (kind: Parameters<typeof view.of>[0], key: string) => {
      const verdict = view.of(kind, key);
      return verdict.signed ? (verdict.attested?.name ?? "signed") : "unsigned";
    };
    expect(name("annotation", id)).toBe("Ada Lovelace");
    expect(name("reply", `${id}/${reply.id}`)).toBe("Ada Lovelace");
    expect(name("reply", `${id}/${early.id}`)).toBe("signed");
    expect(name("version", version.id)).toBe("Ada Lovelace");
    expect(name("peer", "42")).toBe("signed");
    const verdict = view.of("annotation", id);
    expect(verdict.signed && verdict.attested?.email).toBe("ada@example.org");
  });

  test("AT1: other bytes under its key, as erased; put back, attested again", async () => {
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    const id = await comment(s, within);
    s.doc.commit();
    const signatures = index(s);
    const attested = async () => {
      await signatures.idle();
      const verdict = signatures.current().of("annotation", id);
      return verdict.signed && verdict.attested !== undefined;
    };
    expect(await attested()).toBe(true);
    const key = hex(sha256(s.envelope));
    s.doc.getMap(ATTESTATIONS).set(key, new Uint8Array([1, 2, 3]));
    s.doc.commit();
    expect(await attested()).toBe(false);
    addAttestation(s.doc, s.envelope);
    s.doc.commit();
    expect(await attested()).toBe(true);
  });

  test("keys given later: attested once they are, told once", async () => {
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    const id = await comment(s, within);
    s.doc.commit();
    const signatures = index(s, { keys: false });
    await signatures.idle();
    let told = 0;
    signatures.subscribe(() => {
      told += 1;
    });
    signatures.setAttestationKeys(s.configured);
    await signatures.idle();
    const verdict = signatures.current().of("annotation", id);
    expect(verdict.signed && verdict.attested?.name).toBe("Ada Lovelace");
    expect(told).toBeGreaterThan(0);
  });

  test("without a configured key, nothing is attested", async () => {
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    const id = await comment(s, within);
    s.doc.commit();
    const signatures = index(s, { keys: false });
    await signatures.idle();
    const verdict = signatures.current().of("annotation", id);
    expect(verdict.signed && verdict.attested).toBeUndefined();
  });

  test("ID-39: a presence is judged when it is received, by the reader's clock", async () => {
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    s.doc.commit();
    const seal = presenceSealer(s.signing);
    const state = { key: "k1", seq: 1, name: "pseudonym", color: "#123456" };
    const sealed = await seal(state);
    if (!sealed) throw new Error("sealed");
    const others: RemotePresence[] = [
      { ...state, anchor: undefined, head: undefined, ...sealed },
    ];
    const listeners = new Set<() => void>();
    let now = within;
    const signatures = new SignatureIndex({
      documentId: DOC,
      annotationsDoc: s.doc,
      log: new DecisionLog(),
      attestationKeys: s.configured,
      now: () => now,
      presence: {
        others: () => others,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    await signatures.idle();
    const verdict = () => signatures.current().of("presence", "k1");
    const before = verdict();
    expect(before.signed && before.attested?.name).toBe("Ada Lovelace");
    // Received again after the attestation's end: signed only.
    now = (ISSUED + 30 * DAY) * 1000;
    for (const listener of listeners) listener();
    await signatures.idle();
    const after = verdict();
    expect(after.signed).toBe(true);
    expect(after.signed && after.attested).toBeUndefined();
  });
});

// Budget (AGENTS.md §6, analysis 18k): each entry of `attestations` read
// once; nothing read again for another annotation, nor for a revocation
// list; a new entry, alone.
describe("the attestations' budget", () => {
  test("once each; none for anything else; a new one alone", async () => {
    const { counters, resetCounters } = await import("../perf/counters.js");
    const s = await setUp();
    addAttestation(s.doc, s.envelope);
    for (let n = 0; n < 10; n++) await comment(s, within + n);
    s.doc.commit();
    resetCounters();
    const signatures = index(s);
    await signatures.idle();
    expect(counters()["identity.attestation"]).toBe(1);
    resetCounters();
    await comment(s, within + 20);
    signatures.setRevocations({ issuedAt: 1, revoked: new Map() });
    await signatures.idle();
    signatures.current();
    expect(counters()["identity.attestation"] ?? 0).toBe(0);
    // Another attestation of the same key: read, alone.
    const renewed = new Uint8Array([...s.envelope, 0]);
    s.doc.getMap(ATTESTATIONS).set(hex(sha256(renewed)), renewed);
    s.doc.commit();
    await signatures.idle();
    expect(counters()["identity.attestation"]).toBe(1);
  });
});
