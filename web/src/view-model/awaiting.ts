/** What awaits my reply (ADR-0050): derived from an annotation's thread,
 * never written. Pure. */
import {
  type Annotation,
  type SignatureView,
  type Verdict,
  replyKey,
} from "../../lib/src/index.js";

/** Who « I » am (ADR-0050 §2). */
export interface Me {
  /** The fingerprints (ID-5) of my keys, in hexadecimal. */
  keys: ReadonlySet<string>;
  /** The account this page is signed in with, if any. */
  account?: { issuer: string; sub: string };
  /** My pseudonym now: what an unsigned entry of mine carries. */
  pseudonym: string;
}

export interface ThreadEntry {
  /** The annotation's id, or its reply's. */
  id: string;
  owner: "me" | "other";
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Whose an entry is, from its verdict once verified: a signed one by its
 * key or its attested account, never by the name it carries (ID-17); one
 * that carries a signature that didn't verify, another's; an unsigned one
 * by my pseudonym. */
export function entryOwner(
  entry: { author: string; sig?: Uint8Array },
  verdict: Verdict,
  me: Me,
): ThreadEntry["owner"] {
  if (verdict.signed) {
    if (me.keys.has(toHex(verdict.fingerprint))) return "me";
    const { attested } = verdict;
    const { account } = me;
    return attested &&
      account &&
      attested.issuer === account.issuer &&
      attested.sub === account.sub
      ? "me"
      : "other";
  }
  if (entry.sig !== undefined) return "other";
  return entry.author === me.pseudonym ? "me" : "other";
}

/** An annotation's thread, in its order (D-39): the annotation, then its
 * replies. A reply without an id (an older client) is named by its place. */
export function threadOf(
  annotation: Annotation,
  signatures: SignatureView,
  me: Me,
): ThreadEntry[] {
  const thread: ThreadEntry[] = [
    {
      id: annotation.id,
      owner: entryOwner(
        annotation,
        signatures.of("annotation", annotation.id),
        me,
      ),
    },
  ];
  annotation.replies.forEach((reply, at) => {
    const verdict: Verdict =
      reply.id === undefined
        ? { signed: false }
        : signatures.of("reply", replyKey(annotation.id, reply.id));
    thread.push({
      id: reply.id ?? `@${at}`,
      owner: entryOwner(reply, verdict, me),
    });
  });
  return thread;
}

/** The id of an annotation's last entry, as `threadOf` names it: what
 * setting it aside keeps (ADR-0050 §4). */
export function lastEntryId(annotation: Annotation): string {
  const at = annotation.replies.length - 1;
  const last = annotation.replies[at];
  return last ? (last.id ?? `@${at}`) : annotation.id;
}

/** Whether a thread awaits me: its last entry is another's — none of mine,
 * or another's after my last — and I didn't set it aside at that entry. */
export function awaits(
  thread: readonly ThreadEntry[],
  setAside?: string,
): boolean {
  const last = thread.at(-1);
  return last !== undefined && last.owner === "other" && last.id !== setAside;
}
