import type { LoroText } from "loro-crdt";

export type TextDiffOp =
  | { retain: number }
  | { insert: string }
  | { delete: number };

export type PositionalEdit = { from: number; to: number; insert: string };

export function loroDeltaToChangeSpec(
  diff: readonly TextDiffOp[],
): PositionalEdit[] {
  const changes: PositionalEdit[] = [];
  let pos = 0;
  for (const op of diff) {
    if ("retain" in op) {
      pos += op.retain;
    } else if ("insert" in op) {
      changes.push({ from: pos, to: pos, insert: op.insert });
    } else {
      changes.push({ from: pos, to: pos + op.delete, insert: "" });
      pos += op.delete;
    }
  }
  return changes;
}

/** Applies edits (in ascending, non-overlapping document order) to a plain
 * string. Applied back to front so earlier `from`/`to` offsets stay valid. */
export function applyChangesToString(
  str: string,
  changes: readonly PositionalEdit[],
): string {
  let result = str;
  for (let i = changes.length - 1; i >= 0; i--) {
    const { from, to, insert } = changes[i] as PositionalEdit;
    result = result.slice(0, from) + insert + result.slice(to);
  }
  return result;
}

/** Applies editor edits (in ascending, non-overlapping, pre-edit document
 * order — e.g. CodeMirror's `iterChanges` fromA/toA) to a Loro text, back to
 * front for the same reason as `applyChangesToString`. */
export function applyEditorChangesToLoroText(
  text: LoroText,
  changes: readonly PositionalEdit[],
): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    const { from, to, insert } = changes[i] as PositionalEdit;
    if (to > from) text.delete(from, to - from);
    if (insert.length > 0) text.insert(from, insert);
  }
}
