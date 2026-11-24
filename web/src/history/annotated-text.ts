import {
  type Change,
  type LoroDoc,
  type PeerID,
  VersionVector,
} from "loro-crdt";
import { type RangeAnchor, resolveRange } from "../../lib/src/index.js";
import { count } from "../perf/index.js";
import { causalOrder } from "./versions.js";

/** The text an annotation covers, or covered (ADR-0052 §4): on a click,
 * never on a render. Pure: reads the content doc, writes nothing. */

export type AnnotatedText =
  /** TA1: what its range covers now. */
  | { kind: "now"; text: string }
  /** TA2: what it covered before the change that emptied it, by
   * `deletedBy` (a peer) at `deletedAt` (seconds, by its clock). */
  | { kind: "then"; text: string; deletedBy: string; deletedAt: number }
  /** TA5: the history doesn't say. */
  | { kind: "unavailable" };

const UNAVAILABLE: AnnotatedText = { kind: "unavailable" };

/** What `anchor` covers in `contentDoc`; if nothing, what it covered at a
 * past version: a prefix of the changes, in `groupVersions`' order, where
 * its range isn't empty, followed by one where it is — found by bisection,
 * on copies (TA3, TA4). Its deletion being final, that is the last such
 * version, unless text was typed later between its deleted cursors; then
 * an earlier one, where it covered text too. */
export function annotatedText(
  contentDoc: LoroDoc,
  anchor: RangeAnchor,
): AnnotatedText {
  return annotatedTextAt(contentDoc, anchor).text;
}

/** The same, and where its range stands in today's text: the
 * passage, the point where its text was, or nowhere (a cursor refused,
 * D-37) — today's range, resolved once for both. */
export function annotatedTextAt(
  contentDoc: LoroDoc,
  anchor: RangeAnchor,
): { text: AnnotatedText; at: { start: number; end: number } | undefined } {
  const range = resolveRange(contentDoc, anchor) ?? undefined;
  const at = range && { start: range.start, end: range.end };
  if (range && range.end > range.start) {
    const now = contentDoc
      .getText("content")
      .toString()
      .slice(range.start, range.end);
    return { text: { kind: "now", text: now }, at };
  }
  return { text: earlier(contentDoc, anchor), at };
}

/** What `anchor`, empty today, covered at a past version (TA2), or TA5. */
function earlier(contentDoc: LoroDoc, anchor: RangeAnchor): AnnotatedText {
  const changes = causalOrder(contentDoc);
  // Before both its characters exist, the range covers nothing: the
  // first prefix holding them, found without a copy.
  const first = holding(changes, anchor);
  let hi = changes.length; // covers nothing: today's text
  if (first === undefined || first >= hi) return UNAVAILABLE;
  let lo = first;
  let text = coveredAt(contentDoc, changes, lo, anchor);
  if (text === undefined) return UNAVAILABLE;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const covered = coveredAt(contentDoc, changes, mid, anchor);
    if (covered === undefined) hi = mid;
    else [lo, text] = [mid, covered];
  }
  const emptying = changes[lo] as Change;
  return {
    kind: "then",
    text,
    deletedBy: emptying.peer,
    deletedAt: emptying.timestamp,
  };
}

/** The text in `doc` between `anchor`'s cursors, exactly resolved; none
 * if the range is empty, or a cursor is refused (D-37). */
function coveredIn(doc: LoroDoc, anchor: RangeAnchor): string | undefined {
  const range = resolveRange(doc, anchor);
  if (!range || range.end <= range.start) return undefined;
  return doc.getText("content").toString().slice(range.start, range.end);
}

/** The same, at the version of the first `length` changes, on a copy. */
function coveredAt(
  doc: LoroDoc,
  changes: readonly Change[],
  length: number,
  anchor: RangeAnchor,
): string | undefined {
  const reached = new Map<PeerID, number>();
  for (const change of changes.slice(0, length)) {
    reached.set(change.peer, change.counter + change.length);
  }
  count("annotations.textThen");
  const fork = doc.forkAt(doc.vvToFrontiers(new VersionVector(reached)));
  try {
    return coveredIn(fork, anchor);
  } finally {
    fork.free();
  }
}

/** How many changes, from the first, hold both of `anchor`'s characters;
 * `undefined` if one isn't among them (not received, or no character). */
function holding(
  changes: readonly Change[],
  anchor: RangeAnchor,
): number | undefined {
  let length = 0;
  for (const cursor of [anchor.startCursor, anchor.endCursor]) {
    const pos = cursor.pos();
    if (!pos) return undefined;
    const at = changes.findIndex(
      (change) =>
        change.peer === pos.peer &&
        change.counter <= pos.counter &&
        pos.counter < change.counter + change.length,
    );
    if (at < 0) return undefined;
    length = Math.max(length, at + 1);
  }
  return length;
}
