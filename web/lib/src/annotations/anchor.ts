import type { Cursor, LoroDoc, LoroText, VersionVector } from "loro-crdt";
import { resolveCursor } from "../cursor.js";
import { count } from "../perf/index.js";

/** A range anchored by two independent `Cursor`s (start+end), the extraction
 * of the anchoring logic already validated by
 * `crdt-binding/anchored-range.property.test.ts` (docs/adr/0003-*.md) into a
 * reusable module, per phase-4 §1. */
export interface RangeAnchor {
  startCursor: Cursor;
  endCursor: Cursor;
  /** ADR-0014: `endCursor` sits on the range's last character, not on the
   * one after it. Absent on anchors made before (and on zero-width ranges,
   * where both cursors mark the same point). */
  endOnLastChar?: boolean;
}

/** Anchors `[start, end)` of `text` by two `Cursor`s, each on a character
 * of the range: its first and its last (ADR-0014). A Loro cursor follows
 * its character and text inserted before a character goes before it, so
 * an insertion at either boundary stays outside the range, and one strictly
 * inside extends it. (`side` has no observable effect, ADR-0003: anchoring
 * the end on the character *after* the range — as before — pulled text
 * typed at the end boundary into the range.) Returns `undefined` when the
 * document is empty and no cursor can be obtained (same condition
 * `LoroText.getCursor` itself signals). */
export function anchorRange(
  text: LoroText,
  start: number,
  end: number,
): RangeAnchor | undefined {
  const startCursor = text.getCursor(start, 0);
  if (end <= start) {
    return startCursor && { startCursor, endCursor: startCursor };
  }
  const endCursor = text.getCursor(end - 1, 0);
  if (!startCursor || !endCursor) return undefined;
  return { startCursor, endCursor, endOnLastChar: true };
}

/** Resolves an anchor against the current state of `doc`. Returns `null`
 * when the anchored range can no longer be resolved (e.g. the anchored text
 * was entirely deleted, or a cursor that can't be resolved safely, D-37) —
 * phase-4 §1's documented contract for `listAnnotations`. `held` is
 * `doc`'s version, read once by a caller resolving many anchors. */
export function resolveRange(
  doc: LoroDoc,
  anchor: RangeAnchor,
  held: VersionVector = doc.oplogVersion(),
  /** See `resolveCursor`: fast, not exact; never for an effect. */
  forDisplay = false,
): { start: number; end: number } | null {
  count("cursor.resolve", 2);
  // Anchors are written by any reviewer: resolved only if safe (D-37).
  const startPos = resolveCursor(doc, anchor.startCursor, held, forDisplay);
  const endPos = resolveCursor(doc, anchor.endCursor, held, forDisplay);
  if (!startPos || !endPos) return null;
  if (!anchor.endOnLastChar) {
    return { start: startPos.offset, end: endPos.offset };
  }
  // A live last character ends the range right after it; a deleted one
  // (Loro then offers an `update`) resolves to where it was, i.e. right
  // after what remains of the range.
  const end = endPos.offset + (endPos.update ? 0 : 1);
  return { start: startPos.offset, end: Math.max(startPos.offset, end) };
}
