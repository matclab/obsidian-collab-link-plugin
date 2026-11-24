// The alerts of what awaits my reply under a controlled order (AGENTS.md
// §1.6; ADR-0060 §1; phase 34, analysis 34): annotations and replies by me,
// by my other device (a key known once the view is opened), by another;
// each verification of a signature ends when Hegel says (a gate on
// `verifyBytes`); the view looked at or not, at any moment; the opening
// over (history in, who I am known) at any moment; the view closed at the
// end, or before.
//
// At every step: nothing told before the opening is over (NL1), nor while
// looked at, and nothing left shown once looked at (NL4); what is told is
// an annotation where another wrote after my last entry, since the view
// was last looked at (NL3); nothing after the view is closed (NL5). Once
// quiet: another's entry that came in unseen, after the opening, to an
// annotation that awaits me, has been told.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
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
import type { CryptoGate } from "../../../lib/src/transport/test-support/crypto-gate.js";
import { setLanguage } from "../../i18n/index.js";
import { AwaitingIndex } from "../../view-model/awaiting-index.js";
import { PageMe } from "../../view-model/page-me.js";
import { type Attention, attachAlerts } from "./alerts.js";

const verifyGate = vi.hoisted(() => ({ gate: undefined as unknown }));

vi.mock("../../../lib/src/identity/keys.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../lib/src/identity/keys.js")>();
  const { CryptoGate } = await import(
    "../../../lib/src/transport/test-support/crypto-gate.js"
  );
  const gate = new CryptoGate();
  verifyGate.gate = gate;
  return { ...real, verifyBytes: gate.wrap("verify", real.verifyBytes) };
});

const DOC = "doc-1";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
type Writer = "mine" | "myOther" | "theirs";
const WRITERS: Writer[] = ["mine", "myOther", "theirs"];

const keys = (async () => ({
  mine: await signerOf(await generateIdentityKey()),
  myOther: await signerOf(await generateIdentityKey()),
  theirs: await signerOf(await generateIdentityKey()),
}))();

interface Thread {
  id: string;
  entries: { writer: Writer; step: number }[];
  /** The step of another's entry that came in unseen, not told yet. */
  pending?: number;
}

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

/** One scenario, each source of order drawn from `tc`: the property's
 * body, and a counter-example's replay. */
const alertsScenario = async (tc: TC): Promise<void> => {
  setLanguage("en");
  const gate = verifyGate.gate as CryptoGate;
  const signers = await keys;
  gate.start();
  try {
    const contentDoc = new LoroDoc();
    contentDoc.getText("content").insert(0, "a".repeat(200));
    contentDoc.commit();
    const annotationsDoc = new LoroDoc();
    const log = new DecisionLog();
    const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
    const signatures = new SignatureIndex({
      documentId: DOC,
      annotationsDoc,
      log,
    });
    const me = new PageMe("Alice");
    me.setKeys([hex(signers.mine.fingerprint)]);
    const awaiting = new AwaitingIndex({
      annotations: index,
      decisions: new LocalDecisions(log, () => {}),
      signatures,
      me,
      role: "suggest",
    });

    let step = 0;
    let looked = false;
    let opened = false;
    let armed = false;
    /** The step the opening was over: opened, and all verified. */
    let armedAt = Number.POSITIVE_INFINITY;
    let closed = false;
    let lastLooked = -1;
    let open = 0;
    const told: { step: number; id: string }[] = [];
    const threads: Thread[] = [];
    const lookListeners = new Set<() => void>();
    let shown = "";
    const attention: Attention = {
      watched: () => looked,
      subscribe: (listener) => {
        lookListeners.add(listener);
        return () => lookListeners.delete(listener);
      },
      permission: () => "granted",
      request: async () => "granted",
      notify: ({ onClick }) => {
        onClick();
        const id = shown;
        if (closed) throw new Error(`NL5: told ${id} after closing`);
        if (!opened) throw new Error(`NL1: told ${id} before opening`);
        if (looked) throw new Error(`NL4: told ${id} while looked at`);
        const thread = threads.find((t) => t.id === id);
        const entries = thread?.entries ?? [];
        const mine = entries
          .map((e) => e.writer !== "theirs")
          .lastIndexOf(true);
        const fresh = entries
          .slice(mine + 1)
          .some(
            (e) =>
              e.writer === "theirs" && e.step > lastLooked && e.step > armedAt,
          );
        if (!fresh) {
          throw new Error(
            `NL1, NL3: told ${id}: ${JSON.stringify(entries)}, last looked at ${lastLooked}, opened at ${armedAt}`,
          );
        }
        told.push({ step, id });
        open++;
        let gone = false;
        return () => {
          if (!gone) open--;
          gone = true;
        };
      },
    };
    let opening: () => void = () => {};
    const alerts = attachAlerts({
      documentId: DOC,
      awaiting,
      index,
      signatures,
      attention,
      title: () => "Report",
      opened: new Promise<void>((resolve) => {
        opening = resolve;
      }),
      show: (id) => {
        shown = id;
      },
    });

    const signing = (signer: Signer): DocumentSigning => ({
      documentId: DOC,
      signer: async () => signer,
    });
    let at = 0;
    /** Waits until no verification runs out of the test's hands. */
    const quiet = async () => {
      for (let i = 0; i < 10_000 && gate.running > 0; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      if (gate.running > 0) throw new Error("a verification hangs");
      // Every microtask run, however long its chain: a macrotask comes after.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const isQuiet = () =>
      gate.held.length === 0 &&
      gate.running === 0 &&
      signatures.current().settled;
    const check = () => {
      if (looked && open > 0) {
        throw new Error("NL4: a notification left shown, looked at");
      }
      for (const thread of told.filter((t) => t.step === step)) {
        for (const t of threads) {
          if (t.pending !== undefined && t.pending <= thread.step) {
            t.pending = undefined;
          }
        }
      }
      if (!isQuiet() || closed || looked || !armed) return;
      for (const thread of threads) {
        if (thread.pending === undefined) continue;
        if (!awaiting.current().has(thread.id)) {
          thread.pending = undefined;
          continue;
        }
        throw new Error(
          `not told: ${thread.id}, came in at ${thread.pending}: ${JSON.stringify(thread.entries)}`,
        );
      }
    };
    const write = async (to: Thread | undefined, writer: Writer) => {
      let thread = to;
      const signer = signers[writer];
      const author = "Alice";
      if (!thread) {
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
          await sealAnnotation(signing(signer), draft),
        );
        thread = { id: draft.id, entries: [] };
        threads.push(thread);
      } else {
        const draft = draftReply(annotationsDoc, thread.id, {
          author,
          body: "ok",
        });
        writeReply(
          annotationsDoc,
          draft,
          await sealReply(signing(signer), draft),
        );
      }
      thread.entries.push({ writer, step });
      if (writer !== "theirs") thread.pending = undefined;
      else if (armed) thread.pending = step;
    };

    const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
    for (; step < steps; step++) {
      const move = tc.draw(
        gs.sampledFrom([
          "annotate",
          ...(threads.length > 0 ? ["reply", "reply", "reply"] : []),
          ...(gate.held.length > 0 ? ["release", "release"] : []),
          "look",
          ...(opened ? [] : ["open"]),
          ...(closed ? [] : ["close"]),
        ]),
      );
      if (move === "annotate") {
        await write(undefined, tc.draw(gs.sampledFrom(WRITERS)));
      } else if (move === "reply") {
        await write(
          threads[
            tc.draw(gs.integers({ minValue: 0, maxValue: threads.length - 1 }))
          ] as Thread,
          tc.draw(gs.sampledFrom(WRITERS)),
        );
      } else if (move === "release") {
        gate.release(
          gate.held[
            tc.draw(
              gs.integers({ minValue: 0, maxValue: gate.held.length - 1 }),
            )
          ] as (typeof gate.held)[number],
        );
      } else if (move === "look") {
        looked = !looked;
        for (const listener of [...lookListeners]) listener();
      } else if (move === "open") {
        // The history in, and my other key known: the opening over.
        me.setKeys([
          hex(signers.mine.fingerprint),
          hex(signers.myOther.fingerprint),
        ]);
        opened = true;
        opening();
      } else if (move === "close") {
        alerts.destroy();
        closed = true;
      }
      // What the page shows was read since: verifications started.
      signatures.current();
      await quiet();
      if (opened && !armed && isQuiet()) {
        armed = true;
        armedAt = step;
        for (const thread of threads) thread.pending = undefined;
      }
      // Looked at, all verified: everything so far is seen — not before,
      // nothing is seen while a signature is to judge (NL3).
      if (looked && isQuiet()) {
        lastLooked = step;
        for (const thread of threads) thread.pending = undefined;
      }
      check();
    }
    while (!isQuiet()) {
      for (const held of [...gate.held]) gate.release(held);
      await quiet();
    }
    check();
    alerts.destroy();
    awaiting.destroy();
    signatures.destroy();
    index.destroy();
  } finally {
    gate.stop();
  }
};

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails); `done` says whether all were
 * taken. */
function replay(draws: readonly (number | string | boolean)[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("the alerts of what awaits my reply (controlled order)", () => {
  test(
    "never before the opening, never looked at, never after closing; told once quiet",
    () => hegel.testAsync(alertsScenario, { testCases: 300 }),
    600_000,
  );

  // Found on 2026-11-18, writing the scenario (phase 34c), a fault of the
  // scenario's: opened, my annotation, another's, looked at and away while
  // their verifications were held, then another's reply to mine. The
  // scenario took the look for a sight of another's annotation; nothing is
  // seen while a signature is to judge (NL3): both are told once
  // verified.
  test("a counter-example kept: another's reply to mine, after looking away", async () => {
    const { tc, done } = replay([
      10,
      "look",
      "look",
      "look",
      "look",
      "open",
      "annotate",
      "mine",
      "annotate",
      "theirs",
      "look",
      "look",
      "reply",
      0,
      "theirs",
    ]);
    await alertsScenario(tc);
    expect(done()).toBe(true);
  }, 60_000);
});
