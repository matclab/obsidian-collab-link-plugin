/** A scenario trace of one client (one browser tab): what it received and
 * what its user did, in order, enough to replay it in a test
 * (`replay.ts`) — plus a snapshot of its state before each entry, to find
 * where the replay and the browser first disagree. Contains the document in
 * clear text: it stays local, it is never sent to the server. */

/** 2: suggestions are detached (ADR-0018) — an addition's text is no
 * longer in `content`, a version-1 trace can't be replayed faithfully. */
export const TRACE_VERSION = 2;

export interface AnnotationSnapshot {
  id: string;
  type: string;
  status: string;
  range: { start: number; end: number } | null;
}

export interface Snapshot {
  /** The Loro `content` text. */
  text: string;
  /** What the editor shows; differs from `text` only on a bug. */
  view: string;
  annotations: AnnotationSnapshot[];
  /** How many decision records have been confirmed. */
  confirmed: number;
}

/** What a client receives or does — replayed. */
export type InputEvent =
  | { kind: "import"; channel: "content" | "annotations"; bytes: string }
  /** A whole history reply, imported at once. */
  | {
      kind: "importBatch";
      channel: "content" | "annotations";
      updates: string[];
    }
  | { kind: "confirm"; batch: { seq: number; record: string }[] }
  | { kind: "edit"; changes: unknown; userEvent: string }
  | {
      kind: "create";
      type: string;
      from: number;
      to: number;
      extra: string;
      note?: string;
      /** An addition's place, when not the selection's end. */
      addAt?: number;
    }
  | { kind: "propose"; id: string; decision: "accept" | "reject" }
  | { kind: "resolve"; id: string }
  | { kind: "reply"; id: string; body: string };

/** What a client merely reports — not replayed, shown with the rest. */
export type InfoEvent =
  | { kind: "error"; message: string }
  | { kind: "published"; channel: string; bytes: string };

export type TraceEntry =
  | (InputEvent & { at: number; before: Snapshot })
  | (InfoEvent & { at: number });

export interface Trace {
  version: typeof TRACE_VERSION;
  documentId: string;
  author: string;
  /** Wall-clock start (ms since the epoch): entries' `at` are relative to
   * it, which lines up the traces of several tabs. */
  startedAt: number;
  /** Loro peer ids of the two docs, so that replayed local operations get
   * the same ids as in the browser. */
  peers: { content: string; annotations: string };
  /** Every `crypto.randomUUID()` the client drew, in order (annotation and
   * proposal ids). */
  uuids: string[];
  entries: TraceEntry[];
  /** The state when the trace was downloaded. */
  final: Snapshot;
}

export function isInput(entry: TraceEntry): entry is InputEvent & {
  at: number;
  before: Snapshot;
} {
  return "before" in entry;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
