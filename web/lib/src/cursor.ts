import type { Cursor, LoroDoc, VersionVector } from "loro-crdt";
import { count } from "./perf/index.js";

/** The root text every cursor of the protocol points into. */
export const CONTENT_TEXT = "cid:root-content:Text";

/** Where `cursor` is in `doc` now, or `undefined` when it can't be resolved
 * (docs/protocol/03-document.md, D-37). Cursors come from other peers
 * (annotation anchors, presence): `loro-crdt` resolves only one on
 * `content`, at an op `doc` holds. A cursor that `Cursor.decode` accepts
 * can still name a negative counter, and `getCursorPos` then traps and
 * leaves `doc` unusable until the page reloads (1.16.3 and 1.16.4,
 * docs/phase-9-durcissement.md). An op that hasn't arrived
 * yet leaves the cursor unresolved, as `getCursorPos` itself does.
 *
 *`held` is `doc`'s version: a caller resolving many cursors at once reads
 * it once.
 *
 *A cursor whose character was deleted is resolved by walking the history
 * (44 ms on the usage profile, 0.9 s on a year of it, docs/phase-9-
 * durcissement.md); Loro then offers in `update` a cursor
 * on a living character, at the same place now and after any later edit.
 * With `forDisplay`, it is kept, per document, and resolves this cursor
 * from then on: the walk is paid once per page (E3). Not exact: an
 * insertion concurrent with the deletion, arriving after, may land on the
 * other side of the kept cursor (one character off, until the page
 * reloads); and an update that names no character (the text was empty) is
 * never kept. Without it — decision effects, export, the library's
 * `listAnnotations` — exact, and kept updates are not used. */
export function resolveCursor(
  doc: LoroDoc,
  cursor: Cursor,
  held: VersionVector = doc.oplogVersion(),
  forDisplay = false,
): ReturnType<LoroDoc["getCursorPos"]> | undefined {
  if (cursor.containerId() !== CONTENT_TEXT) return undefined;
  const pos = cursor.pos();
  if (pos !== undefined) {
    const { peer, counter } = pos;
    if (!Number.isSafeInteger(counter) || counter < 0) return undefined;
    const end = held.get(peer);
    if (end === undefined || counter >= end) return undefined;
  }
  if (!forDisplay) {
    const resolved = doc.getCursorPos(cursor);
    if (resolved?.update !== undefined) count("cursor.slow");
    return resolved;
  }
  const kept = updatesOf(doc);
  const key = keyOf(cursor);
  const update = kept.get(key);
  if (update) {
    const resolved = doc.getCursorPos(update);
    if (resolved?.update !== undefined) {
      count("cursor.slow"); // its character went too
      if (resolved.update.pos() !== undefined) kept.set(key, resolved.update);
    }
    // The character this cursor names is gone for good: say so, as Loro
    // does (a range's end reads it, D-13).
    return resolved && { ...resolved, update: resolved.update ?? update };
  }
  const resolved = doc.getCursorPos(cursor);
  if (resolved?.update !== undefined) {
    count("cursor.slow");
    if (resolved.update.pos() !== undefined) kept.set(key, resolved.update);
  }
  return resolved;
}

/** Updated cursors, by the bytes of the cursor they replace, per
 * document: forgotten with the document. */
const updates = new WeakMap<LoroDoc, Map<string, Cursor>>();

function updatesOf(doc: LoroDoc): Map<string, Cursor> {
  let kept = updates.get(doc);
  if (!kept) {
    kept = new Map();
    updates.set(doc, kept);
  }
  return kept;
}

function keyOf(cursor: Cursor): string {
  return String.fromCharCode(...cursor.encode());
}
