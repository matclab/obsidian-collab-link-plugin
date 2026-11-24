import { type LoroDoc, type PeerID, decodeImportBlobMeta } from "loro-crdt";
import { count } from "../perf/index.js";
import { sha256 } from "./sha256.js";

/** Detached suggestions (docs/adr/0018-*.md): a reviewer proposes new
 * text without writing to `content`. The insertion is made on a throwaway
 * fork and exported as one change, stored in the annotation; an editor
 * who accepts imports it. Pure: no network, no annotations doc. */

const CONTENT = "cid:root-content:Text";

/** The Loro peer of an annotation's change: the first 8 bytes of
 * SHA-256("obsidian-collab/suggestion/v1" ‖ 0 ‖ annotationId). Targeting
 * an editor's peer would take a preimage (ADR-0018, decision 3). */
export function suggestionPeer(annotationId: string): bigint {
  const digest = sha256(
    new TextEncoder().encode(`obsidian-collab/suggestion/v1\0${annotationId}`),
  );
  return new DataView(digest.buffer).getBigUint64(0);
}

/** The largest free text a client writes, in UTF-8 bytes: a suggestion's
 * proposed text, a comment's body, a reply. One operation must fit in a
 * frame and, for a suggestion's change in base64 (×4/3), in the proposal
 * that accepts it, under the server's 8 MiB
 * (docs/protocol/04-obligations.md, O-18). Checked at creation only. */
export const MAX_TEXT_BYTES = 6_000_000;
/** The former name of `MAX_TEXT_BYTES`. */
export const MAX_SUGGESTION_BYTES = MAX_TEXT_BYTES;

export class TextTooLarge extends Error {
  constructor(message = "This text is too large: at most about 6 MB.") {
    super(message);
  }
}

export class SuggestionTooLarge extends TextTooLarge {
  constructor() {
    super("This suggestion is too large: propose at most about 6 MB of text.");
  }
}

/** Over `MAX_TEXT_BYTES` in UTF-8. The UTF-16 length bounds the UTF-8
 * bytes from below (×1) and above (×3): most texts are never encoded. */
export function isTooLarge(text: string): boolean {
  return (
    text.length > MAX_TEXT_BYTES ||
    (text.length * 3 > MAX_TEXT_BYTES &&
      new TextEncoder().encode(text).length > MAX_TEXT_BYTES)
  );
}

/** In one synchronous call: fork `contentDoc` as it is now, insert `text`
 * at `at` as the annotation's peer, export only that change, drop the
 * fork. `contentDoc` is left untouched: the reviewer has nothing to
 * publish on `content`. */
export function createDetachedChange(
  contentDoc: LoroDoc,
  annotationId: string,
  at: number,
  text: string,
): Uint8Array {
  if (text.length === 0) {
    throw new Error("a suggestion needs some text to propose");
  }
  if (isTooLarge(text)) throw new SuggestionTooLarge();
  const fork = contentDoc.fork();
  try {
    fork.setPeerId(suggestionPeer(annotationId));
    const before = fork.oplogVersion();
    fork.getText("content").insert(at, text);
    fork.commit();
    return fork.export({ mode: "update", from: before });
  } finally {
    fork.free();
  }
}

export type DetachedVerdict =
  /** One insertion into `content`, of `text`, and nothing else. */
  | { kind: "valid"; text: string }
  | { kind: "invalid"; reason: string }
  /** Its dependencies aren't in the doc yet: check again after an import. */
  | { kind: "pending" }
  /** The doc already holds it: its effect is there. */
  | { kind: "present" };

/** The op ids a change carries, per peer (`[start, end)` counters), read
 * without importing it: what the decisions log compares to void a change
 * whose ids an earlier acceptance took. `undefined` if the bytes are not a
 * Loro update. */
export function changeIdSpans(
  change: Uint8Array,
): { peer: string; start: number; end: number }[] | undefined {
  const meta = decodeMeta(change);
  if (!meta || meta.mode !== "update") return undefined;
  const start = meta.partialStartVersionVector.toJSON();
  return [...meta.partialEndVersionVector.toJSON()].map(([peer, end]) => ({
    peer,
    start: start.get(peer) ?? 0,
    end,
  }));
}

function decodeMeta(change: Uint8Array) {
  try {
    return decodeImportBlobMeta(change, true);
  } catch {
    return undefined;
  }
}

/** Checks a change against what ADR-0018 allows: a single insertion into
 * `content`, by the annotation's peer, from counter 0. It reads the
 * change's own operations (decoded on a fork of `contentDoc`, which is
 * left untouched), never their effect on `contentDoc`'s state: once
 * decodable, every editor reaches the same verdict (a diff on the local
 * state would not: choice/loro T8, scenario 11). */
export function checkDetachedChange(
  contentDoc: LoroDoc,
  annotationId: string,
  change: Uint8Array,
): DetachedVerdict {
  const verdict = inspect(contentDoc, annotationId, change, false);
  return verdict.kind === "valid"
    ? { kind: "valid", text: verdict.text }
    : verdict;
}

export type DetachedPreview =
  | { kind: "valid"; text: string; at: number }
  | Exclude<DetachedVerdict, { kind: "valid" }>;

/** `checkDetachedChange`, plus where a valid change would land in
 * `contentDoc` now: what an editor shows of a pending suggestion. That
 * position is only known by importing (a concurrent insertion at the same
 * spot goes first, choice/loro T8, scenario 12), so it holds until the
 * next import; the editor maps it through local edits meanwhile. */
export function previewDetachedChange(
  contentDoc: LoroDoc,
  annotationId: string,
  change: Uint8Array,
): DetachedPreview {
  return inspect(contentDoc, annotationId, change, true);
}

function inspect(
  contentDoc: LoroDoc,
  annotationId: string,
  change: Uint8Array,
  landing: boolean,
): DetachedPreview {
  const meta = decodeMeta(change);
  if (!meta) return invalid("not a Loro update");
  if (meta.mode !== "update") return invalid(`mode ${meta.mode}`);
  const peer = suggestionPeer(annotationId).toString() as PeerID;
  const end = meta.partialEndVersionVector.toJSON();
  if (end.size !== 1 || !end.has(peer)) {
    return invalid("not the annotation's peer");
  }
  if ((meta.partialStartVersionVector.toJSON().get(peer) ?? 0) !== 0) {
    return invalid("does not start at counter 0");
  }
  const version = contentDoc.oplogVersion().toJSON();
  if ((version.get(peer) ?? 0) >= (end.get(peer) as number)) {
    return { kind: "present" };
  }
  // Its dependencies, read without importing: missing ones mean waiting,
  // and cost no fork.
  const missing = meta.startFrontiers.some(
    ({ peer: p, counter }) => (version.get(p) ?? 0) <= counter,
  );
  if (missing) return { kind: "pending" };

  count("detached.check");
  const fork = contentDoc.fork();
  try {
    const before = fork.oplogVersion();
    const frontiers = fork.frontiers();
    const status = fork.import(change);
    if (status.pending && status.pending.size > 0) return { kind: "pending" };
    if (
      !importedOnly(
        before.toJSON(),
        fork.oplogVersion().toJSON(),
        peer,
        end.get(peer) as number,
      )
    ) {
      return invalid("operations beyond the annotation's peer");
    }
    const json = fork.exportJsonUpdates(before, fork.oplogVersion());
    const index = json.peers?.indexOf(peer) ?? -1;
    const changes = json.changes
      .filter((c) => Number(c.id.split("@")[1]) === index)
      .sort((a, b) => Number(a.id.split("@")[0]) - Number(b.id.split("@")[0]));
    if (!onOneLine(changes, index)) {
      return invalid("a piece made on another state of the text");
    }
    const one = oneInsertion(changes.flatMap((c) => c.ops));
    if ("reason" in one) return invalid(one.reason);
    return {
      kind: "valid",
      text: one.text,
      at: landing ? landingOf(fork.diff(frontiers, fork.frontiers(), true)) : 0,
    };
  } catch (error) {
    return invalid(String(error));
  } finally {
    fork.free();
  }
}

/** Whether an import took `before` to `after` by the annotation's `peer`
 * alone, up to the change's `end`: what was checked is all that the real
 * import will apply. The change's header (the peers it announces) is read
 * before the import; a body carrying another peer's operations would
 * otherwise go unchecked (security review of d8dd3cb: not built, guarded). */
export function importedOnly(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  peer: string,
  end: number,
): boolean {
  for (const [p, counter] of after) {
    if (p !== peer && (before.get(p) ?? 0) !== counter) return false;
  }
  return after.get(peer) === end;
}

/** Whether each change after the first depends on the one before it of
 * the same peer, and on nothing else (`index`: the peer's index in the
 * JSON's peer table): the positions of all their operations are then read
 * on one line of states, the first change's plus the peer's own pieces. A
 * piece depending on other operations too was positioned on a state the
 * pieces before it did not see — its position, seemingly right after the
 * last, may land anywhere (found by the security review of the fix that
 * made pieces one insertion). */
export function onOneLine(
  changes: readonly { id: string; deps: readonly string[] }[],
  index: number,
): boolean {
  return changes.every((change, i) => {
    if (i === 0) return true;
    const counter = Number(change.id.split("@")[0]);
    return (
      change.deps.length === 1 && change.deps[0] === `${counter - 1}@${index}`
    );
  });
}

/** The text of the one insertion into `content` that `ops` make, or why
 * they are not one. Read back from the same change, Loro's JSON may give
 * an insertion as one operation in one editor's doc and as several in
 * another's (found by Hegel): pieces each right after the last (positions
 * in code points) are one insertion, so that every editor reaches the same
 * verdict. */
export function oneInsertion(
  ops: readonly { container: string; content: unknown }[],
): { text: string } | { reason: string } {
  let text = "";
  let next: number | undefined;
  for (const op of ops) {
    if (op.container !== CONTENT)
      return { reason: `container ${op.container}` };
    const content = op.content as {
      type: string;
      pos?: unknown;
      text?: unknown;
    };
    if (
      content.type !== "insert" ||
      typeof content.text !== "string" ||
      typeof content.pos !== "number"
    ) {
      return { reason: `operation ${content.type}` };
    }
    if (next !== undefined && content.pos !== next) {
      return { reason: `${ops.length} operations` };
    }
    text += content.text;
    next = content.pos + [...content.text].length;
  }
  if (next === undefined) return { reason: "0 operations" };
  if (text.length === 0) return { reason: "empty insertion" };
  return { text };
}

function invalid(reason: string): { kind: "invalid"; reason: string } {
  return { kind: "invalid", reason };
}

/** The offset of the one insertion a checked change makes. */
function landingOf(diff: ReturnType<LoroDoc["diff"]>): number {
  const [[, textDiff] = []] = diff;
  const [first] = (textDiff as { diff?: { retain?: number }[] })?.diff ?? [];
  return first?.retain ?? 0;
}
