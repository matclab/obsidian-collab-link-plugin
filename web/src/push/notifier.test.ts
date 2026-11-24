// O-41: a reply notifies once acked, a rejection once won; once each,
// never after the view closes.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type Outcome,
  type SubscriptionEntry,
  draftAnnotation,
  draftReply,
  writeAnnotation,
  writeReply,
} from "../../lib/src/index.js";
import { Notifier } from "./notifier.js";

const DOC = "0123456789abcdef0123456789abcdef";

function setup(outcome: () => Outcome | undefined = () => undefined) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "Bonjour");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const annotation = draftAnnotation(contentDoc, {
    type: "deletion",
    start: 0,
    end: 3,
    author: "A",
    note: "inutile",
  });
  writeAnnotation(annotationsDoc, annotation);
  let acked = 0;
  const ackListeners = new Set<() => void>();
  const decisionListeners = new Set<() => void>();
  const posted: { endpoint: string; message: Record<string, unknown> }[] = [];
  const recipient: SubscriptionEntry = {
    key: "k",
    fields: {
      endpoint: "https://fcm.googleapis.com/wp/a",
      p256dh: new Uint8Array(65),
      auth: new Uint8Array(16),
      vapid: new Uint8Array(32),
      createdAt: 1,
    },
  };
  const notifier = new Notifier({
    annotationsDoc,
    documentId: DOC,
    acknowledged: () => acked,
    onAcked: (listener) => {
      ackListeners.add(listener);
      return () => ackListeners.delete(listener);
    },
    decisions: {
      outcome,
      confirmed: () => ({
        proposalId: "p",
        annotationId: annotation.id,
        decision: "reject",
        author: "me",
        seq: 1,
      }),
      subscribe: (listener) => {
        decisionListeners.add(listener);
        return () => decisionListeners.delete(listener);
      },
    },
    mine: () => new Set(),
    vapid: new Uint8Array(32),
    title: () => "Compte rendu",
    name: () => "Moi",
    recipients: async () => [recipient],
    encrypt: async (message) => new TextEncoder().encode(message),
    post: async ({ endpoint, payload }) => {
      posted.push({
        endpoint,
        message: JSON.parse(new TextDecoder().decode(payload)),
      });
      return "sent";
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    annotationsDoc,
    annotationId: annotation.id,
    notifier,
    posted,
    settle,
    ack() {
      acked = annotationsDoc.oplogVersion().get(annotationsDoc.peerIdStr) ?? 0;
      for (const listener of [...ackListeners]) listener();
    },
    decided() {
      for (const listener of [...decisionListeners]) listener();
    },
    reply(body: string) {
      const draft = draftReply(annotationsDoc, annotation.id, {
        author: "Moi",
        body,
      });
      writeReply(annotationsDoc, draft);
      notifier.written({ kind: "reply", draft });
    },
  };
}

describe("the notifier", () => {
  test("a reply notifies once acked, not before, and once", async () => {
    const t = setup();
    t.reply("D'accord.");
    await t.settle();
    expect(t.posted).toEqual([]);
    t.ack();
    await t.settle();
    t.ack();
    await t.settle();
    expect(t.posted).toEqual([
      {
        endpoint: "https://fcm.googleapis.com/wp/a",
        message: {
          v: 1,
          kind: "reply",
          doc: DOC,
          annotation: t.annotationId,
          title: "Compte rendu",
          name: "Moi",
          excerpt: "D'accord.",
        },
      },
    ]);
  });

  test("a rejection notifies once won, with the suggestion's note; not if lost", async () => {
    let outcome: Outcome | undefined;
    const t = setup(() => outcome);
    t.notifier.written({ kind: "rejection", annotationId: t.annotationId });
    outcome = { kind: "pending", decision: "reject" };
    t.decided();
    await t.settle();
    expect(t.posted).toEqual([]);
    outcome = { kind: "won" };
    t.decided();
    t.decided();
    await t.settle();
    expect(t.posted.map((p) => [p.message.kind, p.message.excerpt])).toEqual([
      ["rejected", "inutile"],
    ]);

    const decided: { outcome?: Outcome } = {};
    const u = setup(() => decided.outcome);
    u.notifier.written({ kind: "rejection", annotationId: u.annotationId });
    decided.outcome = {
      kind: "lost",
      winner: {
        proposalId: "q",
        annotationId: u.annotationId,
        decision: "accept",
        author: "B",
        seq: 1,
      },
    };
    u.decided();
    await u.settle();
    expect(u.posted).toEqual([]);
  });

  test("nothing once closed", async () => {
    const t = setup(() => ({ kind: "won" }));
    t.reply("après");
    t.notifier.close();
    t.ack();
    t.notifier.written({ kind: "rejection", annotationId: t.annotationId });
    t.decided();
    await t.settle();
    expect(t.posted).toEqual([]);
  });
});
