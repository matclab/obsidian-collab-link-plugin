// What awaits my reply, kept up to date (ADR-0050 §1, §2, §6, §7; phase
// 23c): from the threads, the verdicts once verified, my keys, the
// decisions and what I set aside; nothing for a keystroke; told at most
// once per microtask.
import { LoroDoc } from "loro-crdt";
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
  generateIdentityKey,
  sealAnnotation,
  sealReply,
  signerOf,
  updateStatus,
  writeAnnotation,
  writeReply,
} from "../../lib/src/index.js";
import { counter, resetCounters } from "../perf/index.js";
import {
  AwaitingIndex,
  type MeSource,
  type SetAsideSource,
} from "./awaiting-index.js";
import type { Me } from "./awaiting.js";

const DOC = "doc-1";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class TestMe implements MeSource {
  private listeners = new Set<() => void>();
  constructor(private me: Me) {}
  current() {
    return this.me;
  }
  set(me: Me) {
    this.me = me;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class TestSetAside implements SetAsideSource {
  version = 0;
  private readonly entries = new Map<string, string>();
  private listeners = new Set<() => void>();
  get(id: string) {
    return this.entries.get(id);
  }
  set(id: string, last: string) {
    this.entries.set(id, last);
    this.version++;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

async function setUp(role: "read" | "suggest" | "edit" = "suggest") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour le monde. ".repeat(4));
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const log = new DecisionLog();
  const annotations = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const signatures = new SignatureIndex({
    documentId: DOC,
    annotationsDoc,
    log,
  });
  const decisions = new LocalDecisions(log, () => {});
  const mine = await signerOf(await generateIdentityKey());
  const theirs = await signerOf(await generateIdentityKey());
  const signing = (signer: Signer): DocumentSigning => ({
    documentId: DOC,
    signer: async () => signer,
  });
  const me = new TestMe({
    keys: new Set([hex(mine.fingerprint)]),
    pseudonym: "Alice",
  });
  const setAside = new TestSetAside();
  const index = new AwaitingIndex({
    annotations,
    decisions,
    signatures,
    me,
    setAside,
    role,
  });
  let at = 0;
  const comment = async (signer: Signer | undefined, author: string) => {
    const draft = draftAnnotation(contentDoc, {
      type: "comment",
      start: at,
      end: at + 1,
      author,
      body: "?",
    });
    at += 2;
    writeAnnotation(
      annotationsDoc,
      draft,
      signer ? await sealAnnotation(signing(signer), draft) : undefined,
    );
    return draft.id;
  };
  const reply = async (id: string, signer: Signer, author: string) => {
    const draft = draftReply(annotationsDoc, id, { author, body: "ok" });
    writeReply(annotationsDoc, draft, await sealReply(signing(signer), draft));
    return draft;
  };
  const settled = async () => {
    await signatures.idle();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    contentDoc,
    annotationsDoc,
    index,
    signatures,
    me,
    mine,
    theirs,
    setAside,
    comment,
    reply,
    settled,
  };
}

const ids = (index: AwaitingIndex) => [...index.current()].sort();

describe("what awaits my reply", () => {
  test("another's comment awaits me once verified; mine doesn't", async () => {
    const s = await setUp();
    const theirs = await s.comment(s.theirs, "Bob");
    await s.comment(s.mine, "Alice");
    // Being verified: neither in nor out.
    expect(ids(s.index)).toEqual([]);
    await s.settled();
    expect(ids(s.index)).toEqual([theirs]);
  });

  test("my reply takes it out; another's after it brings it back", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    await s.reply(id, s.mine, "Alice");
    await s.settled();
    expect(ids(s.index)).toEqual([]);
    await s.reply(id, s.theirs, "Bob");
    await s.settled();
    expect(ids(s.index)).toEqual([id]);
  });

  test("while my reply is being verified, the annotation keeps its state", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    // Read at each notification, as the page does.
    expect(ids(s.index)).toEqual([id]);
    await s.reply(id, s.mine, "Alice");
    expect(ids(s.index)).toEqual([id]);
    await s.settled();
    expect(ids(s.index)).toEqual([]);
  });

  test("a resolved annotation never awaits me (AF1), even while verifying", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    await s.reply(id, s.theirs, "Bob");
    updateStatus(s.annotationsDoc, id, "resolved");
    expect(ids(s.index)).toEqual([]);
  });

  test("set aside at its last entry: out, until another's new entry", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    expect([...s.index.aside()]).toEqual([]);
    s.setAside.set(id, id);
    expect(ids(s.index)).toEqual([]);
    // What would await me but for setting it aside: to put back.
    expect([...s.index.aside()]).toEqual([id]);
    await s.reply(id, s.theirs, "Bob");
    await s.settled();
    expect(ids(s.index)).toEqual([id]);
    expect([...s.index.aside()]).toEqual([]);
  });

  test("a key of mine learnt later (the keyring's `keys`): what it signed is mine", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(ids(s.index)).toEqual([id]);
    s.me.set({
      keys: new Set([hex(s.mine.fingerprint), hex(s.theirs.fingerprint)]),
      pseudonym: "Alice",
    });
    expect(ids(s.index)).toEqual([]);
  });

  test("an unsigned entry: mine under my pseudonym only", async () => {
    const s = await setUp();
    const mine = await s.comment(undefined, "Alice");
    const theirs = await s.comment(undefined, "Bob");
    await s.settled();
    expect(ids(s.index)).toEqual([theirs]);
    expect(mine).toBeDefined();
  });

  test("a reader: nothing awaits", async () => {
    const s = await setUp("read");
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(ids(s.index)).toEqual([]);
  });

  test("told at most once per microtask", async () => {
    const s = await setUp();
    let told = 0;
    s.index.subscribe(() => told++);
    // In one task: two comments (unsigned, written at once), a setting
    // aside, a change of who I am.
    // Unsigned, written before `comment` returns: not awaited here.
    void s.comment(undefined, "Bob");
    void s.comment(undefined, "Bob");
    s.setAside.set("x", "y");
    s.me.set({ keys: new Set(), pseudonym: "Alice" });
    await Promise.resolve();
    await Promise.resolve();
    expect(told).toBe(1);
  });
});

describe("its cost (AF7)", () => {
  test("a keystroke, the others' edits of the text: no computation", async () => {
    const s = await setUp();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    s.index.current();
    resetCounters();
    s.contentDoc.getText("content").insert(0, "x");
    s.contentDoc.commit();
    await s.settled();
    s.index.current();
    expect(counter("awaiting.compute")).toBe(0);
  });

  test("a reply received: one computation; the same state asked again: none", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    s.index.current();
    await s.reply(id, s.theirs, "Bob");
    await s.signatures.idle();
    resetCounters();
    s.index.current();
    s.index.current();
    expect(counter("awaiting.compute")).toBe(1);
  });

  test("growth: one thread read per annotation, one computation", async () => {
    const reads = [];
    for (const n of [4, 16]) {
      const s = await setUp();
      for (let i = 0; i < n; i++) await s.comment(s.theirs, "Bob");
      await s.settled();
      resetCounters();
      s.setAside.set("x", "y");
      s.index.current();
      expect(counter("awaiting.compute")).toBe(1);
      reads.push(counter("awaiting.thread"));
    }
    expect(reads).toEqual([4, 16]);
  });
});
