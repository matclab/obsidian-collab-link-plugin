import {
  type Annotation,
  type AnnotationType,
  type AnnotationsView,
  type ConfirmedProposal,
  type LocalDecisions,
  type Outcome,
  type Role,
  type SignatureView,
  type Verdict,
  replyKey,
} from "../../../lib/src/index.js";
import { formatShortDate, t } from "../../i18n/index.js";

type Action = "accept" | "reject" | "resolve";

/** What a card shows of an annotation, worked out from the
 * shared index and the decisions, never from the docs directly. */
export interface CardModel {
  id: string;
  type: AnnotationType;
  author: string;
  /** Whether it is signed, and by which key (docs/protocol/06-identity.md,
   * ID-17). */
  signature: Verdict;
  /** "commented", "suggests deleting"… */
  verb: string;
  /** Its creation date, written out as a reply's (ADR-0035). */
  when: string;
  /** The text under its range; none for a closed annotation, an
   * unresolvable anchor, or one whose text is deleted. */
  excerpt: string | undefined;
  /** Open, not an addition, its range empty: its text deleted (ADR-0052
   * §3). */
  deleted: boolean;
  /** Who decided a closed one: the author of the decision the journal
   * retains, if it is the one its status says (ADR-0052 §2). */
  decidedBy: { name: string; signature: Verdict } | undefined;
  /** It offers « See the annotated text »: closed, or its text deleted
   * (ADR-0052 §4). */
  seeText: boolean;
  /** A pending suggestion's proposed text, or why it can't be shown. */
  proposal: { kind: "text" | "waiting" | "invalid"; text: string } | undefined;
  body: string | undefined;
  note: string | undefined;
  /** Machine-readable, for the tests and the simulation: `open`,
   * `pending-accept`, `confirmed-reject`, `accepted`… */
  state: string;
  /** What the card says of it, if anything beyond "open". */
  status: string | undefined;
  /** Our decision lost to another's (ADR-0013). */
  lost: string | undefined;
  /** The open annotations it crosses (ADR-0012, layer 2). */
  conflicts: string[];
  actions: Action[];
  open: boolean;
  /** The thread (ADR-0035), in the list's order, its dates written out. */
  replies: readonly CardReply[];
  /** A reviewer or an editor replies to an open annotation (ADR-0035 §4). */
  canReply: boolean;
  /** It awaits my reply, or would but for my setting it aside
   * (ADR-0050). */
  awaiting?: "awaiting" | "set-aside";
}

/** The annotated text a card shows on a click (ADR-0052 §4): the text,
 * and, if it is gone, by whom and when; none if the history doesn't
 * say. */
export type ThenText = { text: string; how?: string } | undefined;

export interface CardReply {
  author: string;
  when: string;
  body: string;
  signature: Verdict;
}

const UNSIGNED: Verdict = { signed: false };

/** The name an object shows (ID-39): its attested one if attested — the
 * pseudonym it carries is then ignored (ADR-0040) —, else the one it
 * carries. */
export function shownName(carried: string, verdict: Verdict): string {
  return verdict.signed && verdict.attested ? verdict.attested.name : carried;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** By a key's fingerprint, in hexadecimal: the cards it signed, the
 * annotation or one of its replies, in their order (ADR-0051 §3). */
export function signedByKey(
  cards: readonly CardModel[],
): Map<string, string[]> {
  const signed = new Map<string, string[]>();
  for (const card of cards) {
    for (const verdict of [
      card.signature,
      ...card.replies.map((reply) => reply.signature),
    ]) {
      if (!verdict.signed) continue;
      const key = toHex(verdict.fingerprint);
      const ids = signed.get(key) ?? [];
      if (ids.at(-1) !== card.id) ids.push(card.id);
      signed.set(key, ids);
    }
  }
  return signed;
}

/** What a verdict shows: two equal keys, the same mark. */
export function verdictKey(verdict: Verdict): string {
  if (!verdict.signed) return "";
  const late = verdict.late
    ? `${verdict.late.dated}|${verdict.late.received}`
    : "";
  // The attestation that names it, a revocation of its key (ID-39), the
  // keys of its name (ID-42).
  const keys = verdict.nameKeys?.map((key) => key.fingerprint).join(",");
  return `${verdict.short}|${verdict.twoKeys}|${late}|${verdict.attested?.id ?? ""}|${verdict.revokedAt ?? ""}|${keys ?? ""}`;
}

const VERB = (): Record<AnnotationType, string> => ({
  comment: t().verbComment,
  addition: t().verbAddition,
  deletion: t().verbDeletion,
  substitution: t().verbSubstitution,
});
const DONE = (): Record<Action, string> => ({
  accept: t().statusAccepted,
  reject: t().statusRejected,
  resolve: t().statusResolved,
});
const ACTION = (): Record<Action, string> => ({
  accept: t().accept,
  reject: t().reject,
  resolve: t().resolve,
});
const STATUS = (): Record<Annotation["status"], string> => ({
  open: t().statusOpen,
  accepted: t().statusAccepted,
  rejected: t().statusRejected,
  resolved: t().statusResolved,
});

const STATUS_OF: Record<Action, Annotation["status"]> = {
  accept: "accepted",
  reject: "rejected",
  resolve: "resolved",
};

/** What a card, or the journal, says an annotation does: « commented »… */
export function verbOf(type: AnnotationType): string {
  return VERB()[type];
}

/** Its status, as the card writes it. */
export function statusOf(status: Annotation["status"]): string {
  return STATUS()[status];
}

/** Who decided a closed annotation: the author of `decision` (the one the
 * journal retains), if it is the one its status says (ADR-0052 §2). */
export function decidedBy(
  annotation: Annotation,
  decision: ConfirmedProposal | undefined,
  signatures?: SignatureView,
): CardModel["decidedBy"] {
  if (
    annotation.status === "open" ||
    !decision ||
    STATUS_OF[decision.decision] !== annotation.status
  ) {
    return undefined;
  }
  const signature = signatures?.of("decision", decision.proposalId) ?? UNSIGNED;
  return { name: shownName(decision.author, signature), signature };
}

export function cardModel(
  annotation: Annotation,
  view: AnnotationsView,
  decisions: LocalDecisions,
  role: Role,
  text: string,
  /** The document's signatures; none: every name unverified. */
  signatures?: SignatureView,
  awaiting?: CardModel["awaiting"],
): CardModel {
  const outcome: Outcome | undefined = decisions.outcome(annotation.id);
  const open = annotation.status === "open";
  // The status is only written once the confirmed decision is applied
  // (ADR-0013), by an editor (docs/phase-5-modele-acces.md, decision 2):
  // until then our own proposal is "pending", a confirmed one waits — for
  // an editor, or, on an editor's page, which applies it at once, for the
  // text its change depends on (ADR-0018).
  const confirmed = open
    ? decisions.confirmed(
        annotation.id,
        annotation.type === "comment" ? "comment" : "suggestion",
      )
    : undefined;
  let state: string = annotation.status;
  let status: string | undefined = open
    ? undefined
    : STATUS()[annotation.status];
  if (confirmed) {
    state = `confirmed-${confirmed.decision}`;
    status = `${DONE()[confirmed.decision]}, ${role === "edit" ? t().waitingForItsText : t().waitingForEditor}`;
  } else if (open && outcome?.kind === "pending") {
    state = `pending-${outcome.decision}`;
    status = t().pendingDecision(ACTION()[outcome.decision]);
  }
  const preview = view.previews.get(annotation.id);
  const proposal =
    preview?.kind === "valid"
      ? { kind: "text" as const, text: preview.text }
      : preview?.kind === "pending"
        ? { kind: "waiting" as const, text: t().proposalWaiting }
        : preview?.kind === "invalid"
          ? { kind: "invalid" as const, text: t().proposalInvalid }
          : undefined;
  const conflicts = view.conflicts.flatMap((pair) =>
    pair.a === annotation.id
      ? [pair.b]
      : pair.b === annotation.id
        ? [pair.a]
        : [],
  );
  // Deciding and resolving are an editor's (ADR-0019 §1), once.
  const undecided = open && outcome === undefined;
  const actions: Action[] =
    role !== "edit" || !undecided
      ? []
      : annotation.type === "comment"
        ? ["resolve"]
        : ["accept", "reject"];
  const signature = signatures?.of("annotation", annotation.id) ?? UNSIGNED;
  const deleted =
    open &&
    annotation.type !== "addition" &&
    annotation.range !== null &&
    annotation.range.end <= annotation.range.start;
  return {
    id: annotation.id,
    type: annotation.type,
    author: shownName(annotation.author, signature),
    signature,
    verb: VERB()[annotation.type],
    when: formatShortDate(annotation.createdAt),
    excerpt:
      annotation.range && !deleted
        ? text.slice(annotation.range.start, annotation.range.end)
        : undefined,
    deleted,
    decidedBy: decidedBy(
      annotation,
      open
        ? undefined
        : decisions.confirmed(
            annotation.id,
            annotation.type === "comment" ? "comment" : "suggestion",
          ),
      signatures,
    ),
    seeText: !open || deleted,
    proposal,
    body: annotation.body,
    note: annotation.note,
    state,
    status,
    lost:
      outcome?.kind === "lost"
        ? t().decisionLost(
            outcome.winner.author,
            DONE()[outcome.winner.decision],
          )
        : undefined,
    conflicts,
    actions,
    open,
    replies: annotation.replies.map((reply) => {
      const signed =
        reply.id !== undefined && signatures
          ? signatures.of("reply", replyKey(annotation.id, reply.id))
          : UNSIGNED;
      return {
        author: shownName(reply.author, signed),
        when: formatShortDate(reply.createdAt),
        body: reply.body,
        signature: signed,
      };
    }),
    canReply: open && role !== "read",
    ...(awaiting && { awaiting }),
  };
}

/** Open annotations first, then closed ones, each group in creation
 * order. Not the text's order: a keystroke moves the passages without the
 * index notifying (it costs nothing per keystroke), so an order by
 * position would go stale; in the margin, each card stands level with its
 * passage anyway. */
export function cardOrder(models: readonly CardModel[]): CardModel[] {
  return [...models].sort((x, y) => Number(y.open) - Number(x.open));
}

function same(x: CardModel, y: CardModel): boolean {
  return (
    x.id === y.id &&
    x.type === y.type &&
    x.author === y.author &&
    verdictKey(x.signature) === verdictKey(y.signature) &&
    x.verb === y.verb &&
    x.when === y.when &&
    x.excerpt === y.excerpt &&
    x.deleted === y.deleted &&
    x.seeText === y.seeText &&
    x.decidedBy?.name === y.decidedBy?.name &&
    verdictKey(x.decidedBy?.signature ?? UNSIGNED) ===
      verdictKey(y.decidedBy?.signature ?? UNSIGNED) &&
    x.proposal?.kind === y.proposal?.kind &&
    x.proposal?.text === y.proposal?.text &&
    x.body === y.body &&
    x.note === y.note &&
    x.state === y.state &&
    x.status === y.status &&
    x.lost === y.lost &&
    x.open === y.open &&
    x.conflicts.join(" ") === y.conflicts.join(" ") &&
    x.actions.join(" ") === y.actions.join(" ") &&
    x.canReply === y.canReply &&
    x.awaiting === y.awaiting &&
    x.replies.length === y.replies.length &&
    x.replies.every((reply, i) => {
      const other = y.replies[i];
      return (
        reply.author === other?.author &&
        reply.when === other.when &&
        reply.body === other.body &&
        verdictKey(reply.signature) === verdictKey(other.signature)
      );
    })
  );
}

/** `next`, each card that shows exactly as before replaced by the object
 * shown before: a card whose model is the same object is not drawn again
 * (a decision confirmed on one annotation redraws that card only). `shown`
 * is kept up to date, cards gone forgotten. */
export function keepUnchanged(
  shown: Map<string, CardModel>,
  next: readonly CardModel[],
): CardModel[] {
  const kept = next.map((card) => {
    const before = shown.get(card.id);
    return before && same(before, card) ? before : card;
  });
  shown.clear();
  for (const card of kept) shown.set(card.id, card);
  return kept;
}
