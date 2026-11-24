// @vitest-environment jsdom
//
// A key brought forward, in the panel (ADR-0051 §4; phase 25c): the cards
// it signed, itself or a reply, stand out; the others are dimmed, their
// text as legible; nothing when no key is chosen.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  type DocumentSigning,
  LocalDecisions,
  SignatureIndex,
  type Signer,
  draftAnnotation,
  draftReply,
  formatShortFingerprint,
  generateIdentityKey,
  sealAnnotation,
  sealReply,
  signerOf,
  writeAnnotation,
  writeReply,
} from "../../../lib/src/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { createAnnotationsPanel } from "./annotations-panel.js";
import { SignerKeys } from "./signer-keys.svelte.js";

const DOC = "doc-1";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function setUp() {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour le monde. ".repeat(4));
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const signatures = new SignatureIndex({
    documentId: DOC,
    annotationsDoc,
    log,
  });
  const decisions = new LocalDecisions(log, () => {});
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const parent = document.createElement("div");
  document.body.append(parent);
  const keys = new SignerKeys();
  const panel = createAnnotationsPanel(
    parent,
    editor,
    index,
    () => "Alice",
    decisions,
    () => {},
    "suggest",
    undefined,
    undefined,
    signatures,
    undefined,
    undefined,
    keys,
  );
  const signing = (signer: Signer): DocumentSigning => ({
    documentId: DOC,
    signer: async () => signer,
  });
  let at = 0;
  const comment = async (signer: Signer) => {
    const draft = draftAnnotation(contentDoc, {
      type: "comment",
      start: at,
      end: at + 1,
      author: "Alice",
      body: "?",
    });
    at += 2;
    writeAnnotation(
      annotationsDoc,
      draft,
      await sealAnnotation(signing(signer), draft),
    );
    return draft.id;
  };
  const reply = async (id: string, signer: Signer) => {
    const draft = draftReply(annotationsDoc, id, {
      author: "Alice",
      body: "ok",
    });
    writeReply(annotationsDoc, draft, await sealReply(signing(signer), draft));
  };
  const settled = async () => {
    await signatures.idle();
    // Every microtask run, however long its chain: a macrotask comes after.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };
  const card = (id: string) =>
    parent.querySelector<HTMLElement>(`.annotation-item[data-id="${id}"]`);
  return { keys, panel, comment, reply, settled, card };
}

describe("a key brought forward, in the panel", () => {
  test("its cards stand out, a reply of it included; the others dimmed; none chosen, nothing", async () => {
    const s = await setUp();
    const a = await signerOf(await generateIdentityKey());
    const b = await signerOf(await generateIdentityKey());
    const byA = await s.comment(a);
    const byB = await s.comment(b);
    const repliedByA = await s.comment(b);
    await s.reply(repliedByA, a);
    await s.settled();
    expect(s.keys.signed.get(hex(a.fingerprint))).toEqual(
      expect.arrayContaining([byA, repliedByA]),
    );
    for (const id of [byA, byB, repliedByA]) {
      expect(s.card(id)?.classList.contains("dimmed")).toBe(false);
      expect(s.card(id)?.classList.contains("brought-forward")).toBe(false);
    }
    s.keys.chosen = {
      fingerprint: hex(a.fingerprint),
      short: formatShortFingerprint(a.fingerprint),
    };
    flushSync();
    expect(s.card(byA)?.classList.contains("brought-forward")).toBe(true);
    expect(s.card(repliedByA)?.classList.contains("brought-forward")).toBe(
      true,
    );
    expect(s.card(byB)?.classList.contains("dimmed")).toBe(true);
    expect(s.card(byA)?.classList.contains("dimmed")).toBe(false);
    s.keys.chosen = undefined;
    flushSync();
    expect(s.card(byB)?.classList.contains("dimmed")).toBe(false);
    s.panel.destroy();
  });
});
