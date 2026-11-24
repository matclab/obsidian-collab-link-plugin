import { LoroDoc } from "loro-crdt";
import {
  DecisionLog,
  applyDecisionEffects,
  encodeProposal,
  resolveAnnotation,
} from "../../lib/src/annotations/index.js";
import {
  type AnnotationDraft,
  annotationMessage,
  decisionMessage,
  draftAddition,
  draftAnnotation,
  tryDraftAnnotation,
  writeAnnotation,
} from "../../lib/src/index.js";
import type { ChannelName } from "../../lib/src/transport/index.js";

export interface ScenarioOptions {
  /** Annotations created, then every one decided (a suggestion) or
   * resolved (a comment) — the state of the manual test document. */
  annotations: number;
  /** Journal entries, at least: typing fills up to this number. */
  entries: number;
  /** Annotations created last and left open, after the typing. */
  open?: number;
  /** Authors taking turns. */
  peers?: number;
  /** Every annotation and decision signed (docs/protocol/06-identity.md)
   * by this key, for this document — synchronously: `node:crypto` in the
   * tests and the bench. */
  signer?: ScenarioSigner;
}

export interface ScenarioSigner {
  documentId: string;
  publicKey: Uint8Array;
  fingerprint: Uint8Array;
  /** The 64-byte Ed25519 signature of `message`. */
  sign(message: Uint8Array): Uint8Array;
}

/** `sig` (ID-7): the short fingerprint, then the signature. */
function sigOf(signer: ScenarioSigner, message: Uint8Array): Uint8Array {
  const sig = new Uint8Array(72);
  sig.set(signer.fingerprint.slice(0, 8), 0);
  sig.set(signer.sign(message), 8);
  return sig;
}

export interface ScenarioEntry {
  channel: ChannelName;
  /** What a client would publish, before encryption. */
  plaintext: Uint8Array;
}

interface Author {
  content: LoroDoc;
  annotations: LoroDoc;
  log: DecisionLog;
}

const WORD = (i: number) => `w${String(i).padStart(4, "0")} `;

/** A deterministic document history, as the server journals it: one entry
 * per commit (what the transport publishes), in journal order. Words typed
 * one commit each; then per annotation, its creation by one author and its
 * decision (or resolution) by the next, the decision's effect applied as the
 * client applies it; then typing up to `entries`; then `open` annotations
 * nobody decides. Annotation `i` sits on
 * word `2i`, so ranges never cross. */
export function generateJournal(options: ScenarioOptions): ScenarioEntry[] {
  const journal: ScenarioEntry[] = [];
  const authors: Author[] = Array.from(
    { length: options.peers ?? 2 },
    (_, index) => {
      const content = new LoroDoc();
      const annotations = new LoroDoc();
      content.setPeerId(BigInt(index + 1));
      annotations.setPeerId(BigInt(index + 1));
      return { content, annotations, log: new DecisionLog() };
    },
  );
  // Each author's commits are journaled and reach every other author at
  // once: a sequential history, no concurrency needed to time an opening.
  for (const [index, author] of authors.entries()) {
    for (const channel of ["content", "annotations"] as const) {
      author[channel].subscribeLocalUpdates((plaintext) => {
        journal.push({ channel, plaintext });
        for (const [other, peer] of authors.entries()) {
          if (other !== index) peer[channel].import(plaintext);
        }
      });
    }
  }
  const at = (turn: number): Author => {
    const author = authors[turn % authors.length];
    if (!author) throw new Error("no authors");
    return author;
  };
  const type = (turn: number, text: string) => {
    const { content } = at(turn);
    const target = content.getText("content");
    target.insert(target.length, text);
    content.commit();
  };

  const words = 2 * (options.annotations + (options.open ?? 0)) + 2;
  for (let i = 0; i < words; i++) type(i, WORD(i));

  const { signer } = options;
  /** Writes a draft, signed if the scenario signs. */
  const write = (creator: Author, draft: AnnotationDraft): string => {
    if (!signer) return writeAnnotation(creator.annotations, draft);
    const message = annotationMessage(
      { documentId: signer.documentId, signer: signer.fingerprint },
      draft.id,
      draft.fields,
    );
    if (!message) throw new Error("scenario annotations are signable");
    return writeAnnotation(creator.annotations, draft, {
      sig: sigOf(signer, message),
      signer,
    });
  };

  const create = (i: number): { id: string; decider: Author } => {
    const creator = at(i);
    const start = WORD(0).length * 2 * i;
    const end = start + WORD(0).length - 1;
    // An integer date: signable (ID-14).
    const input = {
      start,
      end,
      author: `author${i % authors.length}`,
      createdAt: 1_790_000_000_000 + i,
    };
    let draft: AnnotationDraft;
    switch (i % 4) {
      case 0:
        draft = draftAnnotation(creator.content, {
          ...input,
          type: "deletion",
        });
        break;
      case 1: {
        const created = tryDraftAnnotation(
          creator.content,
          creator.annotations,
          { ...input, type: "substitution", replacement: "sub" },
        );
        if (!created.ok) throw new Error("scenario ranges must not cross");
        draft = created.draft;
        break;
      }
      case 2:
        draft = draftAddition(creator.content, {
          at: end,
          text: "add",
          author: input.author,
          createdAt: input.createdAt,
        });
        break;
      default:
        draft = draftAnnotation(creator.content, {
          ...input,
          type: "comment",
          body: `comment ${i}`,
        });
    }
    return { id: write(creator, draft), decider: at(i + 1) };
  };

  for (let i = 0; i < options.annotations; i++) {
    const { id, decider } = create(i);
    const decision =
      i % 4 === 3 ? "resolve" : i % 2 === 0 ? "accept" : "reject";
    // An acceptance carries the annotation's change (ADR-0018).
    const change =
      decision === "accept"
        ? resolveAnnotation(decider.content, decider.annotations, id)?.change
        : undefined;
    const proposal = {
      proposalId: `proposal-${i}`,
      annotationId: id,
      decision,
      author: `author${(i + 1) % authors.length}`,
      ...(change && { change }),
    } as const;
    const message =
      signer &&
      decisionMessage(
        { documentId: signer.documentId, signer: signer.fingerprint },
        proposal.proposalId,
        {
          annotation: id,
          decision,
          author: proposal.author,
          ...(change && { change }),
        },
      );
    const record = encodeProposal({
      ...proposal,
      ...(signer && message && { sig: sigOf(signer, message) }),
    });
    journal.push({ channel: "decisions", plaintext: record });
    for (const author of authors) {
      author.log.add([{ seq: journal.length, record }]);
    }
    const before = decider.content.oplogVersion();
    applyDecisionEffects(decider.content, decider.annotations, decider.log);
    // An imported change is not the decider's own operations: journaled
    // on its own, as the explicit publication of adopted changes will
    //.
    if (change && decider.content.oplogVersion().compare(before) !== 0) {
      journal.push({ channel: "content", plaintext: change });
      for (const author of authors) {
        if (author !== decider) author.content.import(change);
      }
    }
  }

  for (let turn = 0; journal.length < options.entries; turn++) type(turn, "x");
  const total = options.annotations + (options.open ?? 0);
  for (let i = options.annotations; i < total; i++) create(i);
  return journal;
}

/** Characters of content kept by `generateLongHistory`. */
export const LONG_HISTORY_LENGTH = 1100;

/** A long history on content of constant length, like T4
 * (`choice/loro/results/t4-report.md`): `ops` Loro operations (one per
 * character) in all, the text typed first, then one character inserted and
 * one deleted, both at scattered positions, over and over — the history
 * grows, the content does not. Scattered edits are the worst case for the
 * snapshot's size: typing in runs compresses far better. Two authors take
 * turns, a commit of twenty operations each, and see each other's commits
 * at once. `ops - LONG_HISTORY_LENGTH` must be even. Returns the content
 * doc of one of them. */
export function generateLongHistory(ops: number): LoroDoc {
  const rest = ops - LONG_HISTORY_LENGTH;
  if (rest < 0 || rest % 2 !== 0) {
    throw new Error(`ops - ${LONG_HISTORY_LENGTH} must be even and >= 0`);
  }
  const a = new LoroDoc();
  const b = new LoroDoc();
  a.setPeerId(1n);
  b.setPeerId(2n);
  const author = (turn: number) => (turn % 2 === 0 ? a : b);
  const commit = (turn: number) => {
    const from = author(turn);
    const to = author(turn + 1);
    from.commit();
    to.import(from.export({ mode: "update", from: to.oplogVersion() }));
  };
  let turn = 0;
  a.getText("content").insert(0, "x".repeat(LONG_HISTORY_LENGTH));
  commit(turn++);
  // A fixed linear congruential generator: deterministic, and scattered
  // enough that Loro cannot merge neighbouring operations into runs.
  let seed = 1;
  const random = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % bound;
  };
  for (let pair = 0; pair < rest / 2; pair++) {
    const text = author(turn).getText("content");
    const letter = String.fromCharCode(97 + (pair % 26));
    text.insert(random(text.length + 1), letter);
    text.delete(random(text.length), 1);
    if (pair % 10 === 9) commit(turn++);
  }
  commit(turn); // both authors now hold everything
  return a;
}
