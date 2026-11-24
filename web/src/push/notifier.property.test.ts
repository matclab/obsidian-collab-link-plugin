// Notifying under a controlled order (AGENTS.md §1.6; ADR-0060 §5; phase
// 34, analysis 34 bis): my replies to an annotation, another's replies in
// the same thread, my rejection of a suggestion; the server's acks, the
// decision's confirmation (won or lost), the page reloaded (a new
// notifier, the old one closed) — each when Hegel says; every signature
// check, encryption and post ends when Hegel says (one gate).
//
// At every post: to a recipient of D-44 for that object only (NP1), once
// per object and subscription, by the notifier that wrote it, never once
// closed (NP2, NP3), a reply only once acked, a rejection only once won
// (NP3). Once quiet: every object of a notifier still open, acked or won,
// was posted to each of its recipients.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import {
  type Outcome,
  type Signer,
  type SubscriptionFields,
  draftAnnotation,
  draftReply,
  generateIdentityKey,
  sealAnnotation,
  sealReply,
  sealSubscription,
  signerOf,
  subscriptionKey,
  writeAnnotation,
  writeReply,
  writeSubscription,
} from "../../lib/src/index.js";
import type { CryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { Notifier } from "./notifier.js";

const verifyGate = vi.hoisted(() => ({ gate: undefined as unknown }));

vi.mock("../../lib/src/identity/keys.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../lib/src/identity/keys.js")>();
  const { CryptoGate } = await import(
    "../../lib/src/transport/test-support/crypto-gate.js"
  );
  const gate = new CryptoGate();
  verifyGate.gate = gate;
  return { ...real, verifyBytes: gate.wrap("verify", real.verifyBytes) };
});

const DOC = "0123456789abcdef0123456789abcdef";
const VAPID = new Uint8Array(32).fill(7);
const OLD_VAPID = new Uint8Array(32).fill(8);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const people = (async () => ({
  alice: await signerOf(await generateIdentityKey()),
  bob: await signerOf(await generateIdentityKey()),
  carol: await signerOf(await generateIdentityKey()),
  me: await signerOf(await generateIdentityKey()),
}))();

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const signingOf = (signer: Signer) => ({
  documentId: DOC,
  signer: async () => signer,
});

let device = 0;
async function subscribe(
  doc: LoroDoc,
  by: Signer,
  vapid = VAPID,
): Promise<string> {
  device++;
  const fields: SubscriptionFields = {
    endpoint: `https://fcm.googleapis.com/wp/${device}`,
    p256dh: Uint8Array.of(4, ...new Uint8Array(64).fill(device % 250)),
    auth: new Uint8Array(16).fill(1),
    vapid,
    createdAt: 1,
  };
  const seal = await sealSubscription(
    signingOf(by),
    subscriptionKey(fields.endpoint),
    fields,
  );
  if (!seal) throw new Error("not sealed");
  writeSubscription(doc, fields, seal);
  return fields.endpoint;
}

const scenario = async (tc: TC): Promise<void> => {
  const gate = verifyGate.gate as CryptoGate;
  const p = await people;
  gate.start();
  try {
    const contentDoc = new LoroDoc();
    contentDoc.getText("content").insert(0, "Bonjour le monde");
    contentDoc.commit();
    const annotationsDoc = new LoroDoc();
    const annotate = async (by: Signer, type: "comment" | "deletion") => {
      const draft = draftAnnotation(contentDoc, {
        type,
        start: 0,
        end: 5,
        author: "x",
        ...(type === "comment" ? { body: "?" } : { note: "trop long" }),
      });
      writeAnnotation(
        annotationsDoc,
        draft,
        await sealAnnotation(signingOf(by), draft),
      );
      return draft.id;
    };
    gate.stop(); // the setup's own checks: not part of the scenario
    const thread = await annotate(p.alice, "comment");
    const suggestion = await annotate(p.carol, "deletion");
    const alicePhone = await subscribe(annotationsDoc, p.alice);
    await subscribe(annotationsDoc, p.alice, OLD_VAPID);
    const bobPhone = await subscribe(annotationsDoc, p.bob);
    const carolPhone = await subscribe(annotationsDoc, p.carol);
    await subscribe(annotationsDoc, p.me);
    gate.start();

    const peer = annotationsDoc.peerIdStr;
    let acked = 0;
    const ackListeners = new Set<() => void>();
    /** My rejection: undecided, then won or lost. */
    let rejection: "none" | "proposed" | "won" | "lost" = "none";
    const decisionListeners = new Set<() => void>();
    const decisions = {
      outcome: (id: string): Outcome | undefined => {
        if (id !== suggestion || rejection === "none") return undefined;
        if (rejection === "proposed") {
          return { kind: "pending", decision: "reject" };
        }
        return rejection === "won"
          ? { kind: "won" }
          : {
              kind: "lost",
              winner: {
                proposalId: "other",
                annotationId: id,
                decision: "accept",
                author: "y",
                seq: 1,
              },
            };
      },
      confirmed: (id: string) =>
        id === suggestion && rejection === "won"
          ? {
              proposalId: "mine",
              annotationId: id,
              decision: "reject" as const,
              author: "me",
              seq: 1,
            }
          : undefined,
      subscribe: (listener: () => void) => {
        decisionListeners.add(listener);
        return () => decisionListeners.delete(listener);
      },
    };

    /** Each object: the notifier that wrote it, its recipients by the
     * model, and what was posted for it. */
    interface Sent {
      instance: number;
      recipients: Set<string>;
      end: number;
      posted: Set<string>;
    }
    const replies = new Map<string, Sent>(); // by body
    let rejected: Sent | undefined;
    let bobBefore = false;
    let instance = 0;
    let closedUpTo = -1; // instances up to this one are closed
    const violations: string[] = [];

    const make = (id: number) =>
      new Notifier({
        annotationsDoc,
        documentId: DOC,
        acknowledged: (of) => (of === peer ? acked : 0),
        onAcked: (listener) => {
          ackListeners.add(listener);
          return () => ackListeners.delete(listener);
        },
        decisions,
        mine: () => new Set([hex(p.me.fingerprint)]),
        vapid: VAPID,
        title: () => "Doc",
        name: () => "Me",
        encrypt: gate.wrap("encrypt", async (message: string) =>
          new TextEncoder().encode(message),
        ),
        post: gate.wrap("post", async (request) => {
          try {
            check(request, id);
          } catch (error) {
            violations.push((error as Error).message);
          }
          return "sent" as const;
        }),
      });
    const check = (
      request: { endpoint: string; payload: Uint8Array },
      id: number,
    ) => {
      const message = JSON.parse(new TextDecoder().decode(request.payload));
      if (id <= closedUpTo) throw new Error(`NP3: posted by closed #${id}`);
      const sent: Sent | undefined =
        message.kind === "rejected" ? rejected : replies.get(message.excerpt);
      if (!sent) throw new Error("posted an object never written");
      if (sent.instance !== id) {
        throw new Error("NP2: posted by another notifier than its own");
      }
      if (message.kind === "reply" && acked < sent.end) {
        throw new Error("NP3: a reply posted before its ack");
      }
      if (message.kind === "rejected" && rejection !== "won") {
        throw new Error("NP3: a rejection posted without having won");
      }
      if (!sent.recipients.has(request.endpoint)) {
        throw new Error(`NP1: ${request.endpoint} isn't a recipient`);
      }
      if (sent.posted.has(request.endpoint)) {
        throw new Error("NP2: posted twice");
      }
      sent.posted.add(request.endpoint);
    };
    let notifier = make(instance);
    /** Raised by the test, not by the fake: the notifier swallows what its
     * sends throw (best effort), and would hide them. */
    const raise = () => {
      if (violations.length > 0) throw new Error(violations.join("; "));
    };

    /** Until nothing runs out of the test's hands, and nothing starts
     * again once the microtasks are through. */
    const quiet = async () => {
      for (let round = 0; round < 1000; round++) {
        for (let i = 0; i < 10_000 && gate.running > 0; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        if (gate.running > 0) throw new Error("something hangs");
        // Every microtask run, however long its chain: a macrotask comes after.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (gate.running === 0) return;
      }
      throw new Error("something keeps starting");
    };

    /** One composed gesture: every check pending ends, in turn, so that
     * an encryption or a post is soon held — a reload can then fall
     * between them (AGENTS.md §1.6: too long a sequence for chance). */
    const checksEnd = async () => {
      await quiet();
      for (let i = 0; i < 100; i++) {
        const check = gate.held.find((h) => h.label.startsWith("verify"));
        if (!check) break;
        gate.release(check);
        await quiet();
      }
    };
    const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 16 }));
    for (let step = 0; step < steps; step++) {
      const move = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
      switch (move) {
        case 0: {
          // I reply: once signed, written, told.
          const body = `r${step}`;
          const draft = draftReply(annotationsDoc, thread, {
            author: "me",
            body,
          });
          // Signing isn't gated: only checks are.
          const seal = await sealReply(signingOf(p.me), draft);
          writeReply(annotationsDoc, draft, seal);
          replies.set(body, {
            instance,
            recipients: new Set(
              bobBefore ? [alicePhone, bobPhone] : [alicePhone],
            ),
            end: annotationsDoc.oplogVersion().get(peer) ?? 0,
            posted: new Set(),
          });
          notifier.written({ kind: "reply", draft });
          break;
        }
        case 1: {
          // Another replies in the thread.
          const draft = draftReply(annotationsDoc, thread, {
            author: "bob",
            body: `b${step}`,
          });
          // Signing isn't gated: only checks are.
          const seal = await sealReply(signingOf(p.bob), draft);
          writeReply(annotationsDoc, draft, seal);
          bobBefore = true;
          break;
        }
        case 2:
          if (rejection !== "none") break;
          rejection = "proposed";
          rejected = {
            instance,
            recipients: new Set([carolPhone]),
            end: 0,
            posted: new Set(),
          };
          notifier.written({ kind: "rejection", annotationId: suggestion });
          break;
        case 3:
          acked = annotationsDoc.oplogVersion().get(peer) ?? 0;
          for (const listener of [...ackListeners]) listener();
          if (tc.draw(gs.booleans())) await checksEnd();
          break;
        case 4:
          if (rejection !== "proposed") break;
          rejection = tc.draw(gs.booleans()) ? "won" : "lost";
          for (const listener of [...decisionListeners]) listener();
          break;
        case 5:
          if (gate.held.length === 0) break;
          gate.release(
            gate.held[
              tc.draw(
                gs.integers({ minValue: 0, maxValue: gate.held.length - 1 }),
              )
            ] as never,
          );
          break;
        case 6:
          await checksEnd();
          break;
        default:
          // The page reloads: a new notifier, which knows nothing of the old.
          notifier.close();
          closedUpTo = instance;
          instance++;
          notifier = make(instance);
      }
      await quiet();
      raise();
    }
    // Every held step ends, in an order Hegel draws.
    while (gate.held.length > 0) {
      gate.release(
        gate.held[
          tc.draw(gs.integers({ minValue: 0, maxValue: gate.held.length - 1 }))
        ] as never,
      );
      await quiet();
      raise();
    }
    // Liveness: what an open notifier wrote, once acked or won, was posted.
    for (const [body, sent] of replies) {
      if (sent.instance !== instance || acked < sent.end) continue;
      expect(sent.posted, body).toEqual(sent.recipients);
    }
    if (rejected && rejected.instance === instance && rejection === "won") {
      expect(rejected.posted).toEqual(rejected.recipients);
    }
    notifier.close();
  } finally {
    gate.stop();
  }
};

describe("notifying, under a controlled order", () => {
  test("NP1 – NP3 at every post; what was acked or won, posted", () =>
    hegel.testAsync(scenario, { testCases: 200 }));
});
