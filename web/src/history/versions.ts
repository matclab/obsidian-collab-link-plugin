import {
  type Change,
  type LoroDoc,
  type OpId,
  type PeerID,
  VersionVector,
} from "loro-crdt";

/** The content's history as versions: its Loro
 * changes in an order every peer computes alike, cut into groups by
 * author and by pause. Pure: reads the doc, writes nothing. */

/** A pause longer than this starts a new version (decision 6). */
export const DEFAULT_PAUSE_SECONDS = 5 * 60;

export interface VersionChange {
  peer: string;
  counter: number;
  length: number;
  /** Seconds since the epoch, by the author's clock (unverified); 0 for a
   * change made before dates were recorded. */
  timestamp: number;
  message: string | undefined;
}

export interface VersionGroup {
  /** The text after this group: every change up to it, in this order. */
  frontiers: OpId[];
  /** The pseudonym its peers are registered under, if any. */
  author: string | undefined;
  peers: string[];
  /** First and last change's dates, seconds. */
  start: number;
  end: number;
  changes: VersionChange[];
}

/** The versions of `contentDoc`'s text, oldest first. Changes are ordered
 * causally — never before one they depend on, so every prefix is a real
 * state of the text —, and among those that may come next, by date, then
 * Lamport time, then peer: two peers holding the same changes get the same
 * versions, whatever order they received them in. A version ends when the
 * author changes (the pseudonym; the peer when it has none) or after a
 * pause longer than `pauseSeconds`. */
export function groupVersions(
  contentDoc: LoroDoc,
  authorOf: (peer: string) => string | undefined,
  pauseSeconds = DEFAULT_PAUSE_SECONDS,
): VersionGroup[] {
  const groups: VersionGroup[] = [];
  const reached = new Map<PeerID, number>();
  let current: (VersionGroup & { key: string }) | undefined;
  const close = () => {
    if (!current) return;
    const { key: _, ...group } = current;
    group.frontiers = contentDoc.vvToFrontiers(new VersionVector(reached));
    groups.push(group);
  };
  for (const change of causalOrder(contentDoc)) {
    const author = authorOf(change.peer);
    const key = author === undefined ? `peer:${change.peer}` : `@${author}`;
    if (
      !current ||
      current.key !== key ||
      change.timestamp - current.end > pauseSeconds
    ) {
      close();
      current = {
        key,
        frontiers: [],
        author,
        peers: [],
        start: change.timestamp,
        end: change.timestamp,
        changes: [],
      };
    }
    if (!current.peers.includes(change.peer)) {
      current.peers.push(change.peer);
      current.peers.sort();
    }
    current.end = Math.max(current.end, change.timestamp);
    current.changes.push({
      peer: change.peer,
      counter: change.counter,
      length: change.length,
      timestamp: change.timestamp,
      message: change.message,
    });
    reached.set(change.peer, change.counter + change.length);
  }
  close();
  return groups;
}

/** Every change, by date, then Lamport time, then peer. Causal as it is:
 * Loro dates a change no earlier than those it depends on, and its Lamport
 * time is later. A change another client misdated would only make the
 * version of a group include one listed after it — still a real state of
 * the text (`forkAt` takes a version's dependencies along). */
export function causalOrder(doc: LoroDoc): Change[] {
  return [...doc.getAllChanges().values()].flat().sort(earlier);
}

function earlier(x: Change, y: Change): number {
  return (
    x.timestamp - y.timestamp ||
    x.lamport - y.lamport ||
    (x.peer < y.peer ? -1 : x.peer > y.peer ? 1 : x.counter - y.counter)
  );
}
