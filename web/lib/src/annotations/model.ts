import {
  Cursor,
  type LoroDoc,
  LoroList,
  LoroMap,
  type VersionVector,
} from "loro-crdt";
import { addAttestation } from "../identity/attestation.js";
import { type Signer, addIdentity } from "../identity/signature.js";
import { count, span } from "../perf/index.js";
import { type RangeAnchor, anchorRange, resolveRange } from "./anchor.js";
import { TextTooLarge, createDetachedChange, isTooLarge } from "./detached.js";
import { findCreationConflict } from "./overlap.js";

/** The 4 CriticMarkup types in v1 scope (phase-4 §decision 4) — highlight
 * (`{==…==}`) is explicitly out of scope, ADR-0003 never retained it. */
export type AnnotationType =
  | "addition"
  | "deletion"
  | "substitution"
  | "comment";

export type AnnotationStatus = "open" | "accepted" | "rejected" | "resolved";

export interface CreateAnnotationInput {
  type: AnnotationType;
  /** Offsets into the `content` `LoroText`, resolved at creation time. */
  start: number;
  end: number;
  author: string;
  /** Required for `type: "substitution"` — the proposed replacement text,
   * stored as a detached change, never written to `content` (ADR-0018). */
  replacement?: string;
  /** An addition's or substitution's detached change (ADR-0018). */
  change?: Uint8Array;
  /** Required for `type: "comment"` — the comment's own text, never part of
   * `content` (ADR-0003: content stays clean Markdown). */
  body?: string;
  /** Why a suggestion is proposed (phase-5 plan, decision 3 bis). */
  note?: string;
  /** For an import only (ADR-0034): the original creation time. A page
   * never passes it: `Date.now()`. */
  createdAt?: number;
}

/** A reply to an annotation (ADR-0035, D-38): no anchor, never modified. */
export interface Reply {
  author: string;
  /** Milliseconds since the epoch, by the replier's clock (unverified). */
  createdAt: number;
  body: string;
  /** Its id, if its author gave it one (ID-10). */
  id?: string;
  /** Its signature, unchecked (docs/protocol/06-identity.md, ID-7). */
  sig?: Uint8Array;
}

export interface ReplyInput {
  author: string;
  body: string;
  /** For an import only (ADR-0034); default `Date.now()`. */
  createdAt?: number;
}

export interface Annotation {
  id: string;
  type: AnnotationType;
  author: string;
  status: AnnotationStatus;
  createdAt: number;
  /** An addition's or substitution's detached change: its proposed text,
   * never in `content` until an editor imports it (ADR-0018). Anything a
   * reviewer wrote: check it (`checkDetachedChange`) before trusting it. */
  change?: Uint8Array;
  body?: string;
  note?: string;
  /** The thread, in the list's order (D-39): empty if there is none, or
   * if what the entry holds isn't a list. */
  replies: readonly Reply[];
  /** Its signature, unchecked (docs/protocol/06-identity.md, ID-7). */
  sig?: Uint8Array;
  /** Current resolution of the anchored range, or `null` if it can no
   * longer be resolved at all (see anchor.ts — distinct from "entirely
   * deleted", which resolves to a zero-width range, not null). An
   * addition's range is zero-width, at its insertion point. */
  range: { start: number; end: number } | null;
}

const ANNOTATIONS_MAP = "annotations";

function annotationsMap(annotationsDoc: LoroDoc): LoroMap {
  return annotationsDoc.getMap(ANNOTATIONS_MAP);
}

const TYPES: readonly unknown[] = [
  "addition",
  "deletion",
  "substitution",
  "comment",
] satisfies AnnotationType[];
const STATUSES: readonly unknown[] = [
  "open",
  "accepted",
  "rejected",
  "resolved",
] satisfies AnnotationStatus[];

/** The root text the anchors point into. */
const CONTENT_TEXT = "cid:root-content:Text";

/** A cursor on the root text `content`, or `undefined` (D-8): one on any
 * other container would resolve there, and an accepted deletion would
 * erase from `content` positions computed elsewhere. */
function decodeCursor(bytes: unknown): Cursor | undefined {
  if (!(bytes instanceof Uint8Array)) return undefined;
  try {
    const cursor = Cursor.decode(bytes);
    return cursor.containerId() === CONTENT_TEXT ? cursor : undefined;
  } catch {
    return undefined;
  }
}

const optionalString = (value: unknown) =>
  value === undefined || typeof value === "string";

const NO_REPLIES: readonly Reply[] = Object.freeze([]);

/** D-39: the well-formed elements of `replies`, in order; a `replies`
 * that isn't a list reads as none. */
function readReplies(replies: unknown): readonly Reply[] {
  if (!(replies instanceof LoroList) || replies.length === 0) {
    return NO_REPLIES;
  }
  const result: Reply[] = [];
  for (const element of replies.toArray()) {
    if (!(element instanceof LoroMap)) continue;
    const author = element.get("author");
    const createdAt = element.get("createdAt");
    const body = element.get("body");
    if (
      typeof author === "string" &&
      typeof createdAt === "number" &&
      Number.isFinite(createdAt) &&
      typeof body === "string" &&
      body !== ""
    ) {
      const id = element.get("id");
      const sig = element.get("sig");
      result.push({
        author,
        createdAt,
        body,
        ...(typeof id === "string" && { id }),
        ...(sig instanceof Uint8Array && { sig }),
      });
    }
  }
  return result;
}

/** An entry as written by any reviewer or client, checked
 * (docs/protocol/03-document.md, D-8): `undefined` when it isn't an
 * annotation this client can read — skipped, never fatal. */
function readEntry(
  id: string,
  entry: unknown,
): (Omit<Annotation, "range"> & { anchor: RangeAnchor }) | undefined {
  if (!(entry instanceof LoroMap)) return undefined;
  const type = entry.get("type");
  const status = entry.get("status");
  const author = entry.get("author");
  const createdAt = entry.get("createdAt");
  const endOnLastChar = entry.get("endOnLastChar");
  const change = entry.get("change");
  const body = entry.get("body");
  const note = entry.get("note");
  if (
    !TYPES.includes(type) ||
    !STATUSES.includes(status) ||
    typeof author !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    !(endOnLastChar === undefined || typeof endOnLastChar === "boolean") ||
    !(change === undefined || change instanceof Uint8Array) ||
    !optionalString(body) ||
    !optionalString(note)
  ) {
    return undefined;
  }
  const startCursor = decodeCursor(entry.get("startCursor"));
  const endCursor = decodeCursor(entry.get("endCursor"));
  if (!startCursor || !endCursor) return undefined;
  const sig = entry.get("sig");
  return {
    ...(sig instanceof Uint8Array && { sig }),
    id,
    type: type as AnnotationType,
    author,
    status: status as AnnotationStatus,
    createdAt,
    ...(change instanceof Uint8Array && { change }),
    ...(typeof body === "string" && { body }),
    ...(typeof note === "string" && { note }),
    replies: readReplies(entry.get("replies")),
    anchor: {
      startCursor,
      endCursor,
      ...(endOnLastChar === true && { endOnLastChar: true }),
    },
  };
}

/** A signature to write with an object (docs/protocol/06-identity.md,
 * ID-12): its `sig`, and the signer, whose key goes into `identities` in
 * the same commit if the document doesn't hold it. */
export interface Seal {
  sig: Uint8Array;
  /** Only its public key and fingerprint are written. */
  signer: Pick<Signer, "publicKey" | "fingerprint">;
  /** An attestation of that key (ID-38), written with the object. */
  attestation?: Uint8Array;
}

/** An annotation computed and not yet written: what is signed, and its
 * anchors — Loro cursors, which follow what is typed until it is written
 * (cas 9 of phase 18's analysis). */
export interface AnnotationDraft {
  id: string;
  anchor: RangeAnchor;
  fields: {
    type: AnnotationType;
    author: string;
    createdAt: number;
    change?: Uint8Array;
    body?: string;
    note?: string;
  };
}

/** Drafts an annotation: anchors `[start, end)` on `contentDoc`'s `content`
 * text (decision 2/3 of phase-4), now. Throws on a range it can't anchor,
 * or a body over `MAX_TEXT_BYTES`. */
export function draftAnnotation(
  contentDoc: LoroDoc,
  input: CreateAnnotationInput,
  id: string = crypto.randomUUID(),
): AnnotationDraft {
  const anchor = anchorRange(
    contentDoc.getText("content"),
    input.start,
    input.end,
  );
  if (!anchor) {
    throw new Error("cannot anchor a range on an unresolvable text position");
  }
  if (input.body !== undefined && isTooLarge(input.body)) {
    throw new TextTooLarge();
  }
  return {
    id,
    anchor,
    fields: {
      type: input.type,
      author: input.author,
      createdAt: input.createdAt ?? Date.now(),
      ...(input.change !== undefined && { change: input.change }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.note !== undefined &&
        input.note !== "" && { note: input.note }),
    },
  };
}

/** Writes a drafted annotation as a nested `LoroMap` keyed by its id under
 * `annotationsDoc.getMap("annotations")`, so concurrent field-level edits
 * (e.g. two peers both changing `status`) merge per-field rather than
 * clobbering each other — with its seal, if signed, in the same commit
 * (D-7, ID-12). Returns its id. */
export function writeAnnotation(
  annotationsDoc: LoroDoc,
  draft: AnnotationDraft,
  seal?: Seal,
): string {
  const { id, anchor, fields } = draft;
  const entry = annotationsMap(annotationsDoc).setContainer(id, new LoroMap());
  entry.set("type", fields.type);
  entry.set("author", fields.author);
  entry.set("status", "open" satisfies AnnotationStatus);
  entry.set("createdAt", fields.createdAt);
  entry.set("startCursor", anchor.startCursor.encode());
  entry.set("endCursor", anchor.endCursor.encode());
  if (anchor.endOnLastChar) entry.set("endOnLastChar", true);
  if (fields.change !== undefined) entry.set("change", fields.change);
  if (fields.body !== undefined) entry.set("body", fields.body);
  if (fields.note !== undefined) entry.set("note", fields.note);
  // O-39: the list with the annotation, so that two first replies don't
  // each create one (ADR-0035 §2).
  entry.setContainer("replies", new LoroList());
  if (seal) {
    addIdentity(annotationsDoc, seal.signer);
    if (seal.attestation) addAttestation(annotationsDoc, seal.attestation);
    entry.set("sig", seal.sig);
  }
  annotationsDoc.commit();
  return id;
}

/** Creates an annotation, unsigned: drafted and written at once. Returns
 * the new annotation's id. */
export function createAnnotation(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  input: CreateAnnotationInput,
  id: string = crypto.randomUUID(),
): string {
  return writeAnnotation(
    annotationsDoc,
    draftAnnotation(contentDoc, input, id),
  );
}

/** A reply computed and not yet written (ADR-0035, ID-10). */
export interface ReplyDraft {
  annotationId: string;
  /** A random UUID (ID-10). */
  id: string;
  fields: { author: string; createdAt: number; body: string };
}

/** Drafts a reply. Throws on an unknown annotation, an empty text, or one
 * over `MAX_TEXT_BYTES`. */
export function draftReply(
  annotationsDoc: LoroDoc,
  annotationId: string,
  { author, body, createdAt = Date.now() }: ReplyInput,
): ReplyDraft {
  if (!(annotationsMap(annotationsDoc).get(annotationId) instanceof LoroMap)) {
    throw new Error(`no such annotation: ${annotationId}`);
  }
  if (body === "") throw new Error("a reply needs some text");
  if (isTooLarge(body)) throw new TextTooLarge();
  return {
    annotationId,
    id: crypto.randomUUID(),
    fields: { author, createdAt, body },
  };
}

/** Appends a drafted reply to the annotation's thread, its fields and its
 * seal in one commit (ADR-0035, O-39, ID-12), creating the list if an
 * older client's entry has none. Throws on an annotation gone meanwhile. */
export function writeReply(
  annotationsDoc: LoroDoc,
  draft: ReplyDraft,
  seal?: Seal,
): void {
  const entry = annotationsMap(annotationsDoc).get(draft.annotationId);
  if (!(entry instanceof LoroMap)) {
    throw new Error(`no such annotation: ${draft.annotationId}`);
  }
  const existing = entry.get("replies");
  const list =
    existing instanceof LoroList
      ? existing
      : entry.setContainer("replies", new LoroList());
  const reply = list.insertContainer(list.length, new LoroMap());
  reply.set("author", draft.fields.author);
  reply.set("createdAt", draft.fields.createdAt);
  reply.set("body", draft.fields.body);
  reply.set("id", draft.id);
  if (seal) {
    addIdentity(annotationsDoc, seal.signer);
    if (seal.attestation) addAttestation(annotationsDoc, seal.attestation);
    reply.set("sig", seal.sig);
  }
  annotationsDoc.commit();
}

/** An annotation as read, unresolved: its fields (the message of its
 * signature is built from them, ID-13), its sig, its replies — or
 * `undefined` if it isn't one this client reads (D-8). */
export function readAnnotationEntry(
  annotationsDoc: LoroDoc,
  id: string,
):
  | {
      fields: AnnotationDraft["fields"];
      sig?: Uint8Array;
      replies: readonly Reply[];
    }
  | undefined {
  const read = readEntry(id, annotationsMap(annotationsDoc).get(id));
  if (!read) return undefined;
  const { type, author, createdAt, change, body, note, sig, replies } = read;
  return {
    fields: {
      type,
      author,
      createdAt,
      ...(change !== undefined && { change }),
      ...(body !== undefined && { body }),
      ...(note !== undefined && { note }),
    },
    ...(sig !== undefined && { sig }),
    replies,
  };
}

/** Appends a reply, unsigned: drafted and written at once (ADR-0035,
 * O-39). Whatever the annotation's status: the interface offers to reply
 * only to an open one, but a reply to a closed one is no fault. Throws on
 * an unknown annotation, an empty text, or one over `MAX_TEXT_BYTES`. */
export function replyToAnnotation(
  annotationsDoc: LoroDoc,
  annotationId: string,
  input: ReplyInput,
): void {
  writeReply(annotationsDoc, draftReply(annotationsDoc, annotationId, input));
}

/** Lists every annotation, with its anchored range resolved against
 * `contentDoc`'s current state. */
export function listAnnotations(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  options: ListOptions = {},
): Annotation[] {
  count("annotations.resolveAll");
  return span("annotations.list", () =>
    listAnnotationsUncounted(contentDoc, annotationsDoc, options),
  );
}

export interface ListOptions {
  /** `false`: a closed annotation (its stored status isn't `open`) is
   * listed with `range: null`, unresolved. Its anchor may name text
   * rewritten since, which Loro resolves by walking the history
   * (docs/phase-9-durcissement.md, E4); the page shows no
   * excerpt for it. Default: every range resolved. */
  closedRanges?: boolean;
  /** `true`: ranges for display, fast but not exact (`resolveCursor`,
   * phase 9 E3); never for what changes the text. Default: exact. */
  forDisplay?: boolean;
}

function listAnnotationsUncounted(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  { closedRanges = true, forDisplay = false }: ListOptions,
): Annotation[] {
  const result: Annotation[] = [];
  const held = contentDoc.oplogVersion();
  for (const [id, entry] of annotationsMap(annotationsDoc).entries()) {
    const annotation = resolveEntry(
      contentDoc,
      id,
      entry,
      held,
      closedRanges,
      forDisplay,
    );
    if (annotation) result.push(annotation);
  }
  return result;
}

function resolveEntry(
  contentDoc: LoroDoc,
  id: string,
  entry: unknown,
  held?: VersionVector,
  closedRanges = true,
  forDisplay = false,
): Annotation | undefined {
  const read = readEntry(id, entry);
  if (!read) return undefined;
  const { anchor, ...annotation } = read;
  if (!closedRanges && annotation.status !== "open") {
    return { ...annotation, range: null };
  }
  return {
    ...annotation,
    range: resolveRange(contentDoc, anchor, held, forDisplay),
  };
}

/** One annotation, resolved against `contentDoc`'s current state — without
 * resolving any other (`listAnnotations` resolves them all). */
export function resolveAnnotation(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  id: string,
): Annotation | undefined {
  return resolveEntry(contentDoc, id, annotationsMap(annotationsDoc).get(id));
}

/** The anchor of annotation `id`, whatever its status, resolving nothing:
 * to look for the text it covered at a past version (ADR-0052 §4). */
export function annotationAnchor(
  annotationsDoc: LoroDoc,
  id: string,
): RangeAnchor | undefined {
  return readEntry(id, annotationsMap(annotationsDoc).get(id))?.anchor;
}

/** Ids of the annotations of the given status (and types), resolving
 * nothing. */
export function idsWithStatus(
  annotationsDoc: LoroDoc,
  status: AnnotationStatus,
  types: readonly AnnotationType[],
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of annotationsMap(annotationsDoc).entries()) {
    if (
      entry instanceof LoroMap &&
      entry.get("status") === status &&
      types.includes(entry.get("type") as AnnotationType)
    ) {
      ids.push(id);
    }
  }
  return ids;
}

export type CreateAnnotationResult =
  | { ok: true; id: string }
  | { ok: false; conflictWith: string };

export type DraftAnnotationResult =
  | { ok: true; draft: AnnotationDraft }
  | { ok: false; conflictWith: string };

/** ADR-0012 layer 1: drafts the annotation, but only if its proposed
 * range doesn't cross any existing one (`findCreationConflict`) — refuses
 * before anything is written to the CRDT, with the id of the annotation it
 * would have crossed, so the UI (phase-4 §4) can point the user at it. A
 * substitution's replacement becomes its detached change, now. */
export function tryDraftAnnotation(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  input: CreateAnnotationInput,
): DraftAnnotationResult {
  const anchor = anchorRange(
    contentDoc.getText("content"),
    input.start,
    input.end,
  );
  if (!anchor) {
    throw new Error("cannot anchor a range on an unresolvable text position");
  }
  const proposed = resolveRange(contentDoc, anchor);
  if (!proposed) {
    throw new Error(
      "cannot resolve the proposed range right after anchoring it",
    );
  }
  // Only "active" (open) annotations count as conflicts (ADR-0012): a
  // closed one's effect on content, if any, is already applied and it no
  // longer needs its portion of the text protected from new suggestions.
  const existing = listAnnotations(contentDoc, annotationsDoc).filter(
    (a): a is typeof a & { range: NonNullable<(typeof a)["range"]> } =>
      a.range !== null && a.status === "open",
  );
  const conflictWith = findCreationConflict(existing, proposed);
  if (conflictWith) return { ok: false, conflictWith };
  if (input.type === "substitution") {
    // ADR-0018: the replacement is a detached change, inserted right after
    // the old text on a fork; `content` is left untouched.
    const { replacement = "", ...rest } = input;
    const id = crypto.randomUUID();
    const change = createDetachedChange(contentDoc, id, input.end, replacement);
    return {
      ok: true,
      draft: draftAnnotation(contentDoc, { ...rest, change }, id),
    };
  }
  return { ok: true, draft: draftAnnotation(contentDoc, input) };
}

/** `tryDraftAnnotation`, written at once, unsigned. */
export function tryCreateAnnotation(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  input: CreateAnnotationInput,
): CreateAnnotationResult {
  const result = tryDraftAnnotation(contentDoc, annotationsDoc, input);
  if (!result.ok) return result;
  return { ok: true, id: writeAnnotation(annotationsDoc, result.draft) };
}

/** Updates only `status` — never touches the anchor or the author, per
 * phase-4 §1's test contract. */
export function updateStatus(
  annotationsDoc: LoroDoc,
  id: string,
  status: AnnotationStatus,
): void {
  const entry = annotationsMap(annotationsDoc).get(id);
  if (!(entry instanceof LoroMap)) {
    throw new Error(`no such annotation: ${id}`);
  }
  entry.set("status", status);
  annotationsDoc.commit();
}
