/** Decisions as proposals (docs/adr/0013-*.md, 0018-*.md): accepting or
 * rejecting a suggestion, or resolving a comment, publishes a proposal on
 * the `decisions` channel, and the decision is the first proposal of its
 * class the server journaled for that annotation. Pure: no network —
 * records come in as bytes with their seq. */

import { changeIdSpans } from "./detached.js";

export type Decision = "accept" | "reject" | "resolve";

export interface Proposal {
  /** Identifies one click; a retried send journals the same id again. */
  proposalId: string;
  annotationId: string;
  decision: Decision;
  author: string;
  /** Accepting an addition or a substitution: its detached change, copied
   * from the annotation at the click (ADR-0018, decision 3). What every
   * editor imports, whatever the annotation says later. */
  change?: Uint8Array;
  /** Its signature, unchecked (docs/protocol/06-identity.md, ID-7): never
   * part of whether the record is valid (D-25). */
  sig?: Uint8Array;
}

export interface ConfirmedProposal extends Proposal {
  seq: number;
  /** A winning acceptance whose change can't be imported: its op ids
   * overlap an earlier winning acceptance's in the journal, or it is not a
   * Loro update. It still wins, with no effect (ADR-0018, decision 4). */
  void?: true;
}

export function encodeProposal(proposal: Proposal): Uint8Array {
  const { proposalId, annotationId, decision, author, change, sig } = proposal;
  return new TextEncoder().encode(
    JSON.stringify({
      proposalId,
      annotationId,
      decision,
      author,
      ...(change && { change: toBase64(change) }),
      ...(sig && { sig: toBase64(sig) }),
    }),
  );
}

/** What a signature adds to a record at most: `,"sig":"…"`, 72 bytes in
 * base64. */
const SIG_BYTES_IN_RECORD = 10 + 96;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array | undefined {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return undefined;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether the JSON text escapes a lone surrogate anywhere — in a key, an
 * unknown field, a value a duplicate key overrides (docs/protocol/
 * 03-document.md, D-22): most JSON parsers outside JavaScript refuse the
 * whole text, so clients in every language reach the same winner only if
 * such a record is invalid. Checked on the text, before parsing: what
 * `JSON.parse` drops can't be checked after. Decoded as strict UTF-8, the
 * text can't hold an unescaped surrogate. Each escape is read whole, so
 * that `\\u…` (an escaped backslash, then `u`) is not taken for one. */
function escapesLoneSurrogate(text: string): boolean {
  let highEndsAt = -1;
  for (const match of text.matchAll(/\\(?:u([0-9a-fA-F]{4})|[^u])/g)) {
    const code = match[1] === undefined ? -1 : Number.parseInt(match[1], 16);
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (highEndsAt >= 0) {
      if (match.index === highEndsAt && low) {
        highEndsAt = -1;
        continue;
      }
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      highEndsAt = match.index + match[0].length;
    } else if (low) {
      return true;
    }
  }
  return highEndsAt >= 0;
}

/** Records come from other clients: anything malformed decodes to
 * `undefined` and is ignored — by every client alike, so they still agree
 * on the winner. */
export function decodeProposal(bytes: Uint8Array): Proposal | undefined {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (escapesLoneSurrogate(text)) return undefined;
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { proposalId, annotationId, decision, author, change, sig } =
    parsed as Record<string, unknown>;
  if (
    typeof proposalId !== "string" ||
    typeof annotationId !== "string" ||
    (decision !== "accept" &&
      decision !== "reject" &&
      decision !== "resolve") ||
    typeof author !== "string"
  ) {
    return undefined;
  }
  // ID-16: a malformed sig is no signature; the record stays as valid as
  // it is without one (D-25).
  const sigBytes = typeof sig === "string" ? fromBase64(sig) : undefined;
  const signed = sigBytes && { sig: sigBytes };
  if (change === undefined) {
    return { proposalId, annotationId, decision, author, ...signed };
  }
  if (decision !== "accept" || typeof change !== "string") return undefined;
  const changeBytes = fromBase64(change);
  return (
    changeBytes && {
      proposalId,
      annotationId,
      decision,
      author,
      change: changeBytes,
      ...signed,
    }
  );
}

/** The confirmed prefix of the decisions journal. `add` must receive
 * batches in seq order with no gap — what the transport's `onConfirmed`
 * guarantees — so the first proposal seen for an annotation is the first
 * one journaled. Two winners per annotation, one per class (the journal
 * doesn't know an annotation's type; the effect takes the one that fits
 * it): the first accept/reject decides a suggestion, the first resolve
 * resolves a comment. */
export class DecisionLog {
  private readonly winners = new Map<string, ConfirmedProposal>();
  private readonly resolutions = new Map<string, ConfirmedProposal>();
  /** Op ids taken by the winning acceptances so far: peer → spans. */
  private readonly taken = new Map<string, [number, number][]>();
  private readonly confirmed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private batches = 0;

  /** Changes with every confirmed batch: what a reader compares to know
   * whether anything it shows from the log may have changed. */
  get version(): number {
    return this.batches;
  }

  add(batch: { seq: number; record: Uint8Array }[]): void {
    if (batch.length === 0) return;
    this.batches++;
    for (const { seq, record } of batch) {
      const proposal = decodeProposal(record);
      if (!proposal) continue;
      this.confirmed.add(proposal.proposalId);
      const winners =
        proposal.decision === "resolve" ? this.resolutions : this.winners;
      if (winners.has(proposal.annotationId)) continue;
      winners.set(proposal.annotationId, {
        ...proposal,
        seq,
        ...(proposal.change && !this.take(proposal.change) && { void: true }),
      });
    }
    for (const listener of this.listeners) listener();
  }

  /** The decision of a suggestion: its first accept or reject. */
  winner(annotationId: string): ConfirmedProposal | undefined {
    return this.winners.get(annotationId);
  }

  /** The resolution of a comment: its first resolve. */
  resolution(annotationId: string): ConfirmedProposal | undefined {
    return this.resolutions.get(annotationId);
  }

  /** Takes a winning acceptance's op ids, unless an earlier one took some
   * of them (ADR-0018, decision 3): decided on the journal alone, so every
   * client voids the same changes. */
  private take(change: Uint8Array): boolean {
    const spans = changeIdSpans(change);
    if (!spans) return false;
    const overlaps = spans.some(({ peer, start, end }) =>
      (this.taken.get(peer) ?? []).some(([s, e]) => start < e && s < end),
    );
    if (overlaps) return false;
    for (const { peer, start, end } of spans) {
      this.taken.set(peer, [...(this.taken.get(peer) ?? []), [start, end]]);
    }
    return true;
  }

  isConfirmed(proposalId: string): boolean {
    return this.confirmed.has(proposalId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export type Outcome =
  | { kind: "pending"; decision: Decision }
  | { kind: "won" }
  | { kind: "lost"; winner: ConfirmedProposal };

/** This client's own proposals and what became of them — what the UI
 * shows: "pending" from the click until the journal is confirmed up to the
 * winner, then "won" or "lost" (docs/phase-4bis decision 7). In memory: a
 * page reload forgets which proposals were ours. */
export class LocalDecisions {
  private readonly mine = new Map<string, Proposal>();
  /** Records waiting for their signature, in the order of the clicks. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  /** `maxRecordBytes`: the largest record a frame carries (the server's
   * message limit, less a frame's overhead). `seal`: signs a proposal
   * (docs/protocol/06-identity.md, ID-12), its signer's key in the
   * annotations doc before it resolves; without it, records leave at
   * once, unsigned. */
  constructor(
    private readonly log: DecisionLog,
    private readonly publish: (record: Uint8Array) => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly maxRecordBytes = Number.POSITIVE_INFINITY,
    private readonly seal?: (proposal: Proposal) => Promise<Uint8Array>,
  ) {}

  /** Never applies anything itself (ADR-0013 rule 3): the effect follows
   * from the log once confirmed, like anyone else's decision. `false`,
   * publishing nothing, for a record too large for a frame
   * (docs/protocol/04-obligations.md, O-18): the server would cut it, and
   * it would be sent again at every reconnection. Signed, a record
   * leaves once its signature is made, after the page's earlier ones
   *; unsigned if signing fails; never once closed. */
  propose(
    annotationId: string,
    decision: Decision,
    author: string,
    change?: Uint8Array,
  ): boolean {
    const proposal: Proposal = {
      proposalId: this.newId(),
      annotationId,
      decision,
      author,
      ...(change && { change }),
    };
    const record = encodeProposal(proposal);
    const room = this.seal ? SIG_BYTES_IN_RECORD : 0;
    if (record.length + room > this.maxRecordBytes) return false;
    this.mine.set(annotationId, proposal);
    const seal = this.seal;
    if (!seal) {
      this.publish(record);
      return true;
    }
    const signing = seal(proposal).catch(() => undefined);
    this.queue = this.queue.then(async () => {
      const sig = await signing;
      if (this.closed) return;
      this.publish(sig ? encodeProposal({ ...proposal, sig }) : record);
    });
    return true;
  }

  /** The page closes: a record still waiting for its signature never
   * leaves. */
  close(): void {
    this.closed = true;
  }

  /** Changes whenever an outcome may have: a confirmed batch, or a new
   * proposal of ours. */
  get version(): number {
    return this.log.version + this.mine.size;
  }

  /** Fires whenever an outcome may have changed (a confirmed batch). */
  subscribe(listener: () => void): () => void {
    return this.log.subscribe(listener);
  }

  /** The confirmed decision of an annotation of `type`, if any: its
   * resolution for a comment, the winning proposal otherwise. */
  confirmed(
    annotationId: string,
    type: "comment" | "suggestion",
  ): ConfirmedProposal | undefined {
    return type === "comment"
      ? this.log.resolution(annotationId)
      : this.log.winner(annotationId);
  }

  outcome(annotationId: string): Outcome | undefined {
    const proposal = this.mine.get(annotationId);
    if (!proposal) return undefined;
    const winner =
      proposal.decision === "resolve"
        ? this.log.resolution(annotationId)
        : this.log.winner(annotationId);
    if (!winner) return { kind: "pending", decision: proposal.decision };
    return winner.proposalId === proposal.proposalId
      ? { kind: "won" }
      : { kind: "lost", winner };
  }
}
