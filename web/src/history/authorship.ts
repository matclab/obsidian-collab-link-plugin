import { type LoroDoc, LoroMap, type LoroText } from "loro-crdt";
import { peerNames, suggestionPeer } from "../../lib/src/index.js";
import { count } from "../perf/index.js";

/** Who wrote the text (ADR-0059): the Loro peer of each character's
 * insertion, named as the history names it. Pure: reads the docs, writes
 * nothing. Positions are UTF-16, as CodeMirror's. */

/** A stretch of the text inserted by one peer, `[from, to)`. */
export interface AuthorRun {
  from: number;
  to: number;
  /** `undefined` where Loro doesn't say. */
  peer: string | undefined;
}

/** The stretches of `[from, to)`, clamped to the text, one per peer in a
 * row. Loro has no author for the second half of a surrogate pair (nor
 * does its `slice` cut one): it takes the first half's, and a pair is
 * never cut in two. */
export function authorRuns(
  text: LoroText,
  from: number,
  to: number,
): AuthorRun[] {
  const end = Math.min(to, text.length);
  const runs: AuthorRun[] = [];
  let last: AuthorRun | undefined;
  for (let at = from; at < end; at++) {
    count("authorship.char");
    let peer = text.getEditorOf(at);
    if (peer === undefined) {
      // The second half of a pair: its first half says.
      if (last) {
        last.to = at + 1;
        continue;
      }
      if (at > 0) peer = text.getEditorOf(at - 1);
    }
    if (last && last.peer === peer) last.to = at + 1;
    else {
      last = { from: at, to: at + 1, peer };
      runs.push(last);
    }
  }
  return runs;
}

/** A character's insertion. */
export interface Insertion {
  peer: string;
  /** Seconds since the epoch, by its author's clock (unverified);
   * `undefined` when the change recorded none, or isn't in the history
   * (a shallow doc, ADR-0017). */
  at: number | undefined;
}

/** The insertion of the character at `pos` of `contentDoc`'s text, or
 * `undefined` past its end. */
export function insertionAt(
  contentDoc: LoroDoc,
  pos: number,
): Insertion | undefined {
  const text = contentDoc.getText("content");
  const peer = text.getEditorOf(pos);
  if (peer === undefined) return undefined;
  count("authorship.date");
  const id = text.getCursor(pos)?.pos();
  let at: number | undefined;
  try {
    at = id ? contentDoc.getChangeAt(id).timestamp || undefined : undefined;
  } catch {
    // Not in the history: before a shallow doc's root.
  }
  return { peer, at };
}

/** The pseudonym of each peer that wrote `content`: registered, or a
 * suggestion's author for its peer (ADR-0018) — once accepted, its text
 * is theirs. */
export function authors(annotationsDoc: LoroDoc): Map<string, string> {
  const names = peerNames(annotationsDoc);
  for (const [id, entry] of annotationsDoc.getMap("annotations").entries()) {
    if (!(entry instanceof LoroMap)) continue;
    const type = entry.get("type");
    const author = entry.get("author");
    if (
      (type === "addition" || type === "substitution") &&
      typeof author === "string"
    ) {
      names.set(suggestionPeer(id).toString(), author);
    }
  }
  return names;
}

/** Whom a stretch is shown as (ADR-0059 §2): a name, never a signature —
 * a signed name in `peers` proves the name, not the text written under
 * that peer, which anyone may take. */
export interface Person {
  /** Equal for the peers of one name. */
  key: string;
  /** `undefined`: unknown. */
  name: string | undefined;
}

export const UNKNOWN_PERSON: Person = Object.freeze({
  key: "?",
  name: undefined,
});

/** The person a peer writes as, by `names` (from `authors`). */
export function personOf(
  peer: string | undefined,
  names: ReadonlyMap<string, string>,
): Person {
  const name = peer === undefined ? undefined : names.get(peer);
  return name === undefined ? UNKNOWN_PERSON : { key: `@${name}`, name };
}

/** The keys of the persons who wrote in `contentDoc`, by their first
 * change — its Lamport time, then its peer: no wall clock (ADR-0059 §3).
 * A person's first peer places them; unknown peers are left out. A peer
 * whose first change is out of the history (a shallow doc) comes after,
 * by peer. */
export function personOrder(
  contentDoc: LoroDoc,
  names: ReadonlyMap<string, string>,
): string[] {
  count("authorship.order");
  const first = new Map<string, { lamport: number; peer: string }>();
  for (const peer of contentDoc.oplogVersion().toJSON().keys()) {
    const person = personOf(peer, names);
    if (person === UNKNOWN_PERSON) continue;
    let lamport = Number.POSITIVE_INFINITY;
    try {
      lamport = contentDoc.getChangeAt({ peer, counter: 0 }).lamport;
    } catch {
      // Before a shallow doc's root.
    }
    const held = first.get(person.key);
    if (!held || earlier({ lamport, peer }, held) < 0) {
      first.set(person.key, { lamport, peer });
    }
  }
  return [...first].sort(([, x], [, y]) => earlier(x, y)).map(([key]) => key);
}

function earlier(
  x: { lamport: number; peer: string },
  y: { lamport: number; peer: string },
): number {
  if (x.lamport !== y.lamport) return x.lamport < y.lamport ? -1 : 1;
  return x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : 0;
}
