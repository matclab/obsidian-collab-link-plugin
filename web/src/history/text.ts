import type { LoroDoc, OpId, TextDiff } from "loro-crdt";

/** The content's text at a past version, its differences with another,
 * and restoring it. Pure: Loro in, Loro out. */

const CONTENT = "cid:root-content:Text";

/** The text as it was at `frontiers`, read on a fork: `contentDoc` is left
 * untouched. */
export function textAt(contentDoc: LoroDoc, frontiers: OpId[]): string {
  const fork = contentDoc.forkAt(frontiers);
  try {
    return fork.getText("content").toString();
  } finally {
    fork.free();
  }
}

export interface DiffSegment {
  kind: "same" | "added" | "removed";
  text: string;
}

/** What changed from `from` to `to`, as Loro's own diff of the operations
 * between them (not a guess from the two strings): runs of text kept,
 * added, removed. Kept and added runs give the text at `to`; kept and
 * removed ones, the text at `from`. */
export function diffVersions(
  contentDoc: LoroDoc,
  from: OpId[],
  to: OpId[],
): DiffSegment[] {
  const before = textAt(contentDoc, from);
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    if (text.length === 0) return;
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let at = 0;
  for (const item of textDelta(contentDoc, from, to)) {
    if (item.retain !== undefined) {
      push("same", before.slice(at, at + item.retain));
      at += item.retain;
    } else if (item.delete !== undefined) {
      push("removed", before.slice(at, at + item.delete));
      at += item.delete;
    } else if (item.insert !== undefined) {
      push("added", item.insert);
    }
  }
  push("same", before.slice(at));
  return segments;
}

/** Above this, Myers' diff over characters may take long (Loro's own
 * advice): the difference is computed over lines. */
const CHARACTER_DIFF_LIMIT = 50_000;

/** Brings the text back to what it was at `frontiers`, as new operations
 * of this peer committed with `message`: an edit like any other, the
 * history intact (critique 3). Only the text: the annotations and the
 * decisions stay as they are. The edit is the smallest difference between
 * the two *strings*, not between the two sets of operations: text typed
 * again identically since is left alone, and so are the annotations
 * anchored on it. `false` if the text already is that. */
export function restoreText(
  contentDoc: LoroDoc,
  frontiers: OpId[],
  message: string,
): boolean {
  const target = textAt(contentDoc, frontiers);
  const text = contentDoc.getText("content");
  const current = text.toString();
  if (current === target) return false;
  if (Math.max(current.length, target.length) <= CHARACTER_DIFF_LIMIT) {
    text.update(target, { timeoutMs: 1000 });
  } else {
    text.updateByLine(target, { timeoutMs: 1000 });
  }
  contentDoc.commit({ message });
  return true;
}

type Delta = TextDiff["diff"];

function textDelta(contentDoc: LoroDoc, from: OpId[], to: OpId[]): Delta {
  for (const [container, diff] of contentDoc.diff(from, to, false)) {
    if (container === CONTENT && diff.type === "text") return diff.diff;
  }
  return [];
}
