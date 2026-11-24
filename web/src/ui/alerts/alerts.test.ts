// Alerts of what awaits my reply, wired as the page wires them (ADR-0060
// §1; phase 34c): a notification once opened, for another's reply, not
// for mine; the excerpt and the attested name; one per document, counting
// what came in since last looked at; closed when looked at, and after the
// view is gone; the count in the tab's title.
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
  writeAnnotation,
  writeReply,
} from "../../../lib/src/index.js";
import { setLanguage } from "../../i18n/index.js";
import { AwaitingIndex } from "../../view-model/awaiting-index.js";
import { PageMe } from "../../view-model/page-me.js";
import {
  type AlertPermission,
  type Attention,
  attachAlerts,
} from "./alerts.js";

const DOC = "doc-1";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

class TestAttention implements Attention {
  looked = false;
  allowed: AlertPermission = "granted";
  shown: { tag: string; title: string; body: string; onClick: () => void }[] =
    [];
  open = 0;
  counts: number[] = [];
  private readonly listeners = new Set<() => void>();
  watched() {
    return this.looked;
  }
  look(looked: boolean) {
    this.looked = looked;
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  permission() {
    return this.allowed;
  }
  async request() {
    return this.allowed;
  }
  notify(notification: TestAttention["shown"][number]) {
    this.shown.push(notification);
    this.open++;
    let closed = false;
    return () => {
      if (!closed) this.open--;
      closed = true;
    };
  }
  count(n: number) {
    this.counts.push(n);
  }
}

async function setUp() {
  setLanguage("en");
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
  const mine = await signerOf(await generateIdentityKey());
  const theirs = await signerOf(await generateIdentityKey());
  const signing = (signer: Signer): DocumentSigning => ({
    documentId: DOC,
    signer: async () => signer,
  });
  const me = new PageMe("Alice");
  me.setKeys([hex(mine.fingerprint)]);
  const awaiting = new AwaitingIndex({
    annotations: index,
    decisions,
    signatures,
    me,
    role: "suggest",
  });
  const attention = new TestAttention();
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const shown: string[] = [];
  const alerts = attachAlerts({
    documentId: DOC,
    awaiting,
    index,
    signatures,
    attention,
    title: () => "Report",
    opened,
    show: (id) => shown.push(id),
  });
  let at = 0;
  const comment = async (signer: Signer, author: string, body = "?") => {
    const draft = draftAnnotation(contentDoc, {
      type: "comment",
      start: at,
      end: at + 1,
      author,
      body,
    });
    at += 2;
    writeAnnotation(
      annotationsDoc,
      draft,
      await sealAnnotation(signing(signer), draft),
    );
    return draft.id;
  };
  const reply = async (
    id: string,
    signer: Signer,
    author: string,
    body = "ok",
  ) => {
    const draft = draftReply(annotationsDoc, id, { author, body });
    writeReply(annotationsDoc, draft, await sealReply(signing(signer), draft));
  };
  /** Every verification over, and the index's notification told. */
  const settled = async () => {
    await signatures.idle();
    // Every microtask run, however long its chain: a macrotask comes after.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Opened: the history in, and who I am known. */
  const opening = async () => {
    await settled();
    open();
    await settled();
  };
  return {
    attention,
    alerts,
    comment,
    reply,
    settled,
    opening,
    shown,
    mine,
    theirs,
  };
}

describe("alerts of what awaits my reply", () => {
  test("nothing for what awaits me at opening; then another's reply", async () => {
    const s = await setUp();
    const id = await s.comment(s.mine, "Alice");
    await s.reply(id, s.theirs, "Bob");
    await s.opening();
    expect(s.attention.shown).toEqual([]);
    await s.reply(id, s.theirs, "Bob", "Not  so\nsure.");
    await s.settled();
    expect(s.attention.shown).toMatchObject([
      { tag: `oc:${DOC}`, title: "Report", body: "Bob replied: Not so sure." },
    ]);
  });

  test("nothing before the view is opened, even arrived since", async () => {
    const s = await setUp();
    const id = await s.comment(s.mine, "Alice");
    await s.settled();
    await s.reply(id, s.theirs, "Bob");
    await s.settled();
    await s.opening();
    expect(s.attention.shown).toEqual([]);
  });

  test("nothing for my own reply", async () => {
    const s = await setUp();
    const id = await s.comment(s.theirs, "Bob");
    await s.opening();
    await s.reply(id, s.mine, "Alice");
    await s.settled();
    expect(s.attention.shown).toEqual([]);
  });

  test("another's comment, its excerpt cut", async () => {
    const s = await setUp();
    await s.opening();
    await s.comment(s.theirs, "Bob", "x".repeat(200));
    await s.settled();
    expect(s.attention.shown[0]?.body).toBe(
      `Bob commented: ${"x".repeat(119)}…`,
    );
  });

  test("one notification at a time, counting what came in unseen", async () => {
    const s = await setUp();
    await s.opening();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(s.attention.shown.map((n) => n.body)).toEqual([
      "Bob commented: ?",
      "2 annotations await your reply",
    ]);
    expect(s.attention.open).toBe(1);
  });

  test("looked at: closed, nothing told, and counted afresh", async () => {
    const s = await setUp();
    await s.opening();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    s.attention.look(true);
    expect(s.attention.open).toBe(0);
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(s.attention.shown).toHaveLength(1);
    s.attention.look(false);
    await s.comment(s.theirs, "Bob", "!");
    await s.settled();
    expect(s.attention.shown.at(-1)?.body).toBe("Bob commented: !");
  });

  test("a click shows the annotation", async () => {
    const s = await setUp();
    await s.opening();
    const id = await s.comment(s.theirs, "Bob");
    await s.settled();
    s.attention.shown[0]?.onClick();
    expect(s.shown).toEqual([id]);
  });

  test("without the permission, nothing is shown", async () => {
    const s = await setUp();
    s.attention.allowed = "default";
    await s.opening();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(s.attention.shown).toEqual([]);
  });

  test("the tab counts what awaits me, looked at or not", async () => {
    const s = await setUp();
    await s.comment(s.theirs, "Bob");
    await s.opening();
    s.attention.look(true);
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(s.attention.counts.at(-1)).toBe(2);
  });

  test("once destroyed: closed, nothing more, a click does nothing (NL5)", async () => {
    const s = await setUp();
    await s.opening();
    await s.comment(s.theirs, "Bob");
    await s.settled();
    s.alerts.destroy();
    expect(s.attention.open).toBe(0);
    await s.comment(s.theirs, "Bob");
    await s.settled();
    expect(s.attention.shown).toHaveLength(1);
    s.attention.shown[0]?.onClick();
    expect(s.shown).toEqual([]);
  });
});
