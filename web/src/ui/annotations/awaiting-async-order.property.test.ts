// What awaits my reply under a controlled order (AGENTS.md §1.6; ADR-0050
// §6; phase 23c, AF1, AF5): annotations and replies written by me, by my
// other device (a key the keyring's `keys` will tell later), by another,
// or unsigned under a name; each verification of a signature ends when
// Hegel says (a gate on `verifyBytes`); my other key learnt at any moment;
// an annotation set aside at its last entry, or resolved; the index read
// as the page reads it, after its notification or not.
//
// At every step: a closed annotation never awaits me (AF1); an annotation
// awaits me as the model says, or as it did at the read before — never
// a third state, never in or out on a verdict not yet known. Once nothing
// is held nor running: exactly as the model says (AF5).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test, vi } from "vitest";
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
} from "../../../lib/src/index.js";
import type { CryptoGate } from "../../../lib/src/transport/test-support/crypto-gate.js";
import {
  AwaitingIndex,
  type MeSource,
  type SetAsideSource,
} from "../../view-model/awaiting-index.js";
import type { Me } from "../../view-model/awaiting.js";

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
type Writer = "mine" | "myOther" | "theirs" | "Alice" | "Bob";
const WRITERS: Writer[] = ["mine", "myOther", "theirs", "Alice", "Bob"];

// Keys drawn once: the property is about orders, not keys.
const keys = (async () => ({
  mine: await signerOf(await generateIdentityKey()),
  myOther: await signerOf(await generateIdentityKey()),
  theirs: await signerOf(await generateIdentityKey()),
}))();

interface Thread {
  id: string;
  entries: { id: string; writer: Writer }[];
  resolved: boolean;
}

describe("what awaits my reply (controlled order)", () => {
  test(
    "never closed, never a state on a verdict not yet known; the model's once quiet",
    () =>
      hegel.testAsync(
        async (tc) => {
          const gate = verifyGate.gate as CryptoGate;
          const signers = await keys;
          gate.start();
          try {
            const contentDoc = new LoroDoc();
            contentDoc.getText("content").insert(0, "a".repeat(200));
            contentDoc.commit();
            const annotationsDoc = new LoroDoc();
            const log = new DecisionLog();
            const annotations = new AnnotationIndex(
              contentDoc,
              annotationsDoc,
              log,
            );
            const signatures = new SignatureIndex({
              documentId: DOC,
              annotationsDoc,
              log,
            });
            let me: Me = {
              keys: new Set([hex(signers.mine.fingerprint)]),
              pseudonym: "Alice",
            };
            const meListeners = new Set<() => void>();
            const meSource: MeSource = {
              current: () => me,
              subscribe: (l) => {
                meListeners.add(l);
                return () => meListeners.delete(l);
              },
            };
            const aside = new Map<string, string>();
            const asideListeners = new Set<() => void>();
            const setAside: SetAsideSource = {
              get: (id) => aside.get(id),
              version: 0,
              subscribe: (l) => {
                asideListeners.add(l);
                return () => asideListeners.delete(l);
              },
            };
            const index = new AwaitingIndex({
              annotations,
              decisions: new LocalDecisions(log, () => {}),
              signatures,
              me: meSource,
              setAside,
              role: "suggest",
            });
            let otherKeyKnown = false;
            const threads: Thread[] = [];
            let at = 0;

            const signing = (signer: Signer): DocumentSigning => ({
              documentId: DOC,
              signer: async () => signer,
            });
            const signerOfWriter = (writer: Writer) =>
              writer === "mine" || writer === "myOther" || writer === "theirs"
                ? signers[writer]
                : undefined;
            const owner = (writer: Writer) =>
              writer === "mine" ||
              (writer === "myOther" && otherKeyKnown) ||
              writer === "Alice"
                ? "me"
                : "other";
            const model = (thread: Thread) => {
              const last = thread.entries.at(-1);
              return (
                !thread.resolved &&
                last !== undefined &&
                owner(last.writer) === "other" &&
                aside.get(thread.id) !== last.id
              );
            };
            /** Waits until no verification runs out of the test's hands. */
            const quiet = async () => {
              for (let i = 0; i < 10_000 && gate.running > 0; i++) {
                await new Promise((r) => setTimeout(r, 0));
              }
              if (gate.running > 0) throw new Error("a verification hangs");
              // Every microtask run, however long its chain: a macrotask comes after.
              await new Promise((resolve) => setTimeout(resolve, 0));
            };

            let previous = new Set<string>();
            const read = () => {
              const now = index.current();
              for (const thread of threads) {
                const has = now.has(thread.id);
                if (thread.resolved && has) {
                  throw new Error(`AF1: ${thread.id} resolved, awaiting`);
                }
                if (has !== model(thread) && has !== previous.has(thread.id)) {
                  throw new Error(
                    `${thread.id}: ${has}, the model ${model(thread)}, before ${previous.has(thread.id)}: ${JSON.stringify(thread.entries.map((e) => e.writer))} aside ${aside.get(thread.id) === thread.entries.at(-1)?.id} known ${otherKeyKnown} settled ${signatures.current().settled} held ${gate.held.length}`,
                  );
                }
              }
              previous = new Set(now);
            };
            /** Quiet: no verification held nor running, none left to
             * start (the index starts them when read). */
            const isQuiet = () =>
              gate.held.length === 0 &&
              gate.running === 0 &&
              signatures.current().settled;
            const settledCheck = () => {
              if (!isQuiet()) return;
              read();
              const now = index.current();
              for (const thread of threads) {
                if (now.has(thread.id) !== model(thread)) {
                  throw new Error(
                    `AF5: ${thread.id} ${now.has(thread.id)}, the model ${model(thread)}: ${JSON.stringify(thread)} known ${otherKeyKnown}`,
                  );
                }
              }
            };
            // Told: the page reads, or not yet — drawn after the step,
            // never in the notification (a draw there would depend on
            // when the machine ends a signature).
            let told = false;
            index.subscribe(() => {
              told = true;
            });

            const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
            for (let step = 0; step < steps; step++) {
              const open = threads.filter((t) => !t.resolved);
              const move = tc.draw(
                gs.sampledFrom([
                  "annotate",
                  ...(open.length > 0
                    ? ["reply", "reply", "aside", "resolve"]
                    : []),
                  ...(gate.held.length > 0
                    ? ["release", "release", "release"]
                    : []),
                  ...(otherKeyKnown ? [] : ["learn"]),
                  "read",
                ]),
              );
              if (move === "annotate") {
                const writer = tc.draw(gs.sampledFrom(WRITERS));
                const draft = draftAnnotation(contentDoc, {
                  type: "comment",
                  start: at,
                  end: at + 1,
                  author: writer === "Bob" ? "Bob" : "Alice",
                  body: "?",
                });
                at += 2;
                const signer = signerOfWriter(writer);
                writeAnnotation(
                  annotationsDoc,
                  draft,
                  signer
                    ? await sealAnnotation(signing(signer), draft)
                    : undefined,
                );
                threads.push({
                  id: draft.id,
                  entries: [{ id: draft.id, writer }],
                  resolved: false,
                });
              } else if (move === "reply") {
                const thread = tc.draw(gs.sampledFrom(open));
                const writer = tc.draw(gs.sampledFrom(WRITERS));
                const draft = draftReply(annotationsDoc, thread.id, {
                  author: writer === "Bob" ? "Bob" : "Alice",
                  body: "ok",
                });
                const signer = signerOfWriter(writer);
                writeReply(
                  annotationsDoc,
                  draft,
                  signer ? await sealReply(signing(signer), draft) : undefined,
                );
                thread.entries.push({ id: draft.id, writer });
              } else if (move === "aside") {
                const thread = tc.draw(gs.sampledFrom(open));
                const last = thread.entries.at(-1);
                if (last) aside.set(thread.id, last.id);
                (setAside as { version: number }).version++;
                for (const l of asideListeners) l();
              } else if (move === "resolve") {
                const thread = tc.draw(gs.sampledFrom(open));
                updateStatus(annotationsDoc, thread.id, "resolved");
                thread.resolved = true;
              } else if (move === "release") {
                const held = tc.draw(gs.sampledFrom(gate.held));
                gate.release(held);
              } else if (move === "learn") {
                otherKeyKnown = true;
                me = {
                  keys: new Set([
                    hex(signers.mine.fingerprint),
                    hex(signers.myOther.fingerprint),
                  ]),
                  pseudonym: "Alice",
                };
                for (const l of meListeners) l();
              }
              await quiet();
              if (told) {
                told = false;
                if (tc.draw(gs.booleans())) read();
              }
              if (move === "read") read();
              // What the page shows was read since: verifications started.
              signatures.current();
              await quiet();
              settledCheck();
            }
            // The end: every verification released, the model's.
            while (!isQuiet()) {
              for (const held of [...gate.held]) gate.release(held);
              await quiet();
            }
            read();
            settledCheck();
            index.destroy();
            signatures.destroy();
            annotations.destroy();
          } finally {
            gate.stop();
          }
        },
        { testCases: 300 },
      ),
    600_000,
  );
});
