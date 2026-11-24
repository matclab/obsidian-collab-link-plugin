// @vitest-environment jsdom
//
// Signing what the page writes, under any order of its asynchronous work
// (docs/protocol/06-identity.md, ID-12; analysis 18g, cases 9 and SG5;
// AGENTS.md §1.6). The page's own wiring (`wireClient`: the panel, the
// decisions, with a key), and the peers' registration. Every source of
// order is a choice of the test: what the user does (create each kind of
// annotation, reply, decide, resolve), text typed while a signature runs,
// when each signature ends (`cryptoGate`, on `sign`), and when the
// page closes. At every step:
// - every annotation, reply and name in `peers` the document holds is
//   signed, and verifies against its `identities` (SG5: never written
//   without its signature);
// - every decision record left signed, its key already in the
//   annotations doc (ID-12), in the order of the clicks;
// - every annotation's range still resolves (the anchors followed);
// - once closed, nothing more is written nor sent.
// At the end, everything clicked before closing was written.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { decodeProposal } from "../../lib/src/annotations/decisions.js";
import {
  type KnownKey,
  type Proposal,
  annotationMessage,
  decisionMessage,
  generateIdentityKey,
  listAnnotations,
  peerMessage,
  peerSignature,
  readAnnotationEntry,
  readIdentities,
  registerOnFirstEdit,
  replyMessage,
  sealPeers,
  signerOf,
  verify,
} from "../../lib/src/index.js";
import { cryptoGate } from "../../lib/src/transport/test-support/crypto-gate.js";
import { wireClient } from "../app/wire-client.js";

// The whole signature — its message, hashes included, and Ed25519 — is
// one piece of work whose end the test decides.
vi.mock("../../lib/src/identity/signature.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../lib/src/identity/signature.js")
    >();
  const { cryptoGate } = await import(
    "../../lib/src/transport/test-support/crypto-gate.js"
  );
  return { ...real, sign: cryptoGate.wrap("sign", real.sign) };
});

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const DOC = "doc-1";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const flush = () => new Promise((resolve) => setImmediate(resolve));

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Until nothing runs that the test doesn't time: no signature running,
 * and none started over several turns of both event queues (Loro's
 * events, the panel's microtasks). */
async function settle(): Promise<void> {
  let quiet = 0;
  let seen = -1;
  while (quiet < 3) {
    await flush();
    await turn();
    const now = cryptoGate.held.length;
    if (cryptoGate.running === 0 && now === seen) quiet++;
    else quiet = 0;
    seen = now;
  }
}

/** The problems with what the document holds now (SG5, anchors). */
async function check(
  content: LoroDoc,
  annotations: LoroDoc,
  peers: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  const known: KnownKey[] = await readIdentities(annotations);
  const context = (signer: Uint8Array) => ({ documentId: DOC, signer });
  for (const annotation of listAnnotations(content, annotations)) {
    const read = readAnnotationEntry(annotations, annotation.id);
    if (!read) continue;
    const by = await verify(read.sig, known, (s) =>
      annotationMessage(context(s), annotation.id, read.fields),
    );
    if (!by) problems.push(`annotation ${annotation.id} not signed`);
    if (annotation.range === null) {
      problems.push(`annotation ${annotation.id} lost its range`);
    }
    for (const reply of read.replies) {
      const ok = await verify(reply.sig, known, (s) =>
        replyMessage(context(s), reply.id, {
          annotation: annotation.id,
          author: reply.author,
          createdAt: reply.createdAt,
          body: reply.body,
        }),
      );
      if (!ok) problems.push(`a reply of ${annotation.id} not signed`);
    }
  }
  const names = annotations.getMap("peers");
  for (const peer of peers) {
    const name = names.get(peer);
    if (name === undefined) continue;
    const ok = await verify(peerSignature(annotations, peer), known, (s) =>
      peerMessage(context(s), peer, name),
    );
    if (!ok) problems.push(`peer ${peer} named unsigned`);
  }
  return problems;
}

describe("signing under any order of the page's asynchronous work", () => {
  test(
    "never written without its signature; decisions in order; nothing after closing",
    () =>
      hegel.testAsync(
        async (tc: TC) => {
          const signer = await signerOf(await generateIdentityKey());
          const identityName = hex(signer.fingerprint);
          cryptoGate.start();
          try {
            const content = new LoroDoc();
            const annotations = new LoroDoc();
            content.getText("content").insert(0, "Bonjour le monde entier.");
            content.commit();
            const signing = { documentId: DOC, signer: async () => signer };
            const published: {
              proposal: Proposal;
              keyThere: boolean;
            }[] = [];
            let closed = false;
            let sentAfterClose = false;
            const client = wireClient({
              contentDoc: content,
              annotationsDoc: annotations,
              editorParent: document.createElement("div"),
              panelParent: document.createElement("div"),
              author: () => "Alice",
              documentId: DOC,
              publishDecision: (record) => {
                if (closed) sentAfterClose = true;
                const proposal = decodeProposal(record);
                if (!proposal) throw new Error("undecodable record");
                published.push({
                  proposal,
                  // ID-12: the key is in the annotations doc already.
                  keyThere:
                    annotations
                      .getMap("identities")
                      .get(identityName) instanceof Uint8Array,
                });
              },
              confirm: () => true,
              signing,
            });
            const registration = registerOnFirstEdit({
              contentDoc: content,
              annotationsDoc: annotations,
              channels: ["content", "annotations"],
              author: () => "Alice",
              seal: (peers, name) => sealPeers(signing, peers, name),
            });
            const peers = [content.peerIdStr, annotations.peerIdStr];
            const clicked: string[] = []; // annotation ids decided, in order
            let created = 0;
            let replies = 0;
            let frozen: Uint8Array | undefined;

            for (
              let step = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
              step > 0;
              step--
            ) {
              const moves = [
                "create",
                "create",
                "type",
                "reply",
                "decide",
                "decide",
              ];
              if (cryptoGate.held.length > 0) {
                moves.push("release", "release", "releaseLast");
              }
              // One gesture: two decisions in a row, so that two of their
              // signatures run at once (AGENTS.md §1.6).
              moves.push("decideTwice");
              if (!closed) moves.push("close");
              const move = tc.draw(gs.sampledFrom(moves));
              const length = content.getText("content").length;
              const open = client.index
                .current()
                .annotations.filter((a) => a.status === "open");
              if (move === "create" && !closed) {
                const type = tc.draw(
                  gs.sampledFrom([
                    "comment",
                    "deletion",
                    "addition",
                    "substitution",
                  ] as const),
                );
                const from = tc.draw(
                  gs.integers({ minValue: 0, maxValue: length - 1 }),
                );
                const to =
                  type === "addition"
                    ? from
                    : tc.draw(
                        gs.integers({ minValue: from + 1, maxValue: length }),
                      );
                client.editor.view.dispatch({
                  selection: { anchor: from, head: to },
                });
                const problem = client.panel.create(
                  type,
                  type === "deletion" ? "" : "texte",
                  "",
                );
                if (problem === undefined) created++;
              } else if (move === "type") {
                // Typing while signatures run: never deleting, so that
                // every range must still resolve.
                const at = tc.draw(
                  gs.integers({ minValue: 0, maxValue: length }),
                );
                content.getText("content").insert(at, "x");
                content.commit();
              } else if (move === "reply" && open.length > 0 && !closed) {
                const target = tc.draw(gs.sampledFrom(open));
                if (client.panel.reply(target.id, "réponse") === undefined) {
                  replies++;
                }
              } else if (
                (move === "decide" || move === "decideTwice") &&
                open.length > 0 &&
                !closed
              ) {
                const times = move === "decideTwice" ? 2 : 1;
                const left = [...open];
                for (let n = 0; n < times && left.length > 0; n++) {
                  // Two different annotations: their order shows.
                  const target = tc.draw(gs.sampledFrom(left));
                  left.splice(left.indexOf(target), 1);
                  if (target.type === "comment")
                    client.panel.resolve(target.id);
                  else {
                    client.panel.decide(
                      target.id,
                      tc.draw(gs.sampledFrom(["accept", "reject"] as const)),
                    );
                  }
                  clicked.push(target.id);
                }
              } else if (move === "releaseLast") {
                const held = cryptoGate.held[cryptoGate.held.length - 1];
                if (held) cryptoGate.release(held);
              } else if (move === "release") {
                const i = tc.draw(
                  gs.integers({
                    minValue: 0,
                    maxValue: cryptoGate.held.length - 1,
                  }),
                );
                const held = cryptoGate.held[i];
                if (held) cryptoGate.release(held);
              } else if (move === "close") {
                closed = true;
                client.panel.destroy();
                client.decisions.close();
                registration.stop();
                frozen = annotations.oplogVersion().encode();
              }
              await settle();
              const problems = await check(content, annotations, peers);
              expect(problems).toEqual([]);
              for (const { proposal, keyThere } of published) {
                expect(keyThere, proposal.proposalId).toBe(true);
              }
            }

            // The end: every signature let through, in order.
            while (cryptoGate.held.length > 0) {
              const held = cryptoGate.held[0];
              if (held) cryptoGate.release(held);
              await settle();
            }
            cryptoGate.stop();
            expect(await check(content, annotations, peers)).toEqual([]);
            const known = await readIdentities(annotations);
            for (const { proposal } of published) {
              const ok = await verify(proposal.sig, known, (s) =>
                decisionMessage(
                  { documentId: DOC, signer: s },
                  proposal.proposalId,
                  {
                    annotation: proposal.annotationId,
                    decision: proposal.decision,
                    author: proposal.author,
                    ...(proposal.change && { change: proposal.change }),
                  },
                ),
              );
              expect(ok, `decision ${proposal.proposalId}`).toBeDefined();
            }
            if (closed) {
              expect(sentAfterClose).toBe(false);
              expect(
                hex(annotations.oplogVersion().encode()),
                "nothing written once closed",
              ).toBe(hex(frozen ?? new Uint8Array()));
              expect(published.map((p) => p.proposal.annotationId)).toEqual(
                clicked.slice(0, published.length),
              );
            } else {
              // Everything clicked was written, and sent in order.
              const entries = [
                ...annotations.getMap("annotations").values(),
              ].filter((v) => v instanceof LoroMap);
              expect(entries).toHaveLength(created);
              const written = listAnnotations(content, annotations).reduce(
                (n, a) => n + a.replies.length,
                0,
              );
              expect(written).toBe(replies);
              expect(published.map((p) => p.proposal.annotationId)).toEqual(
                clicked,
              );
            }
          } finally {
            cryptoGate.stop();
          }
        },
        { testCases: 150 },
      ),
    600_000,
  );
});
