import { StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import {
  type ConfirmedRecord,
  type DocumentConnection,
  type DocumentSigning,
  Presence,
  type Registration,
  type Role,
  type SocketFactory,
  connectDocument,
  mayPublish,
  presenceSealer,
  registerOnFirstEdit,
  sealPeers,
} from "../../lib/src/index.js";
import type { EditorFactory } from "../editor/editor.js";
import { attachRemoteCursors } from "../editor/remote-cursors.js";
import { type DocumentLock, openLocalState } from "../storage/index.js";
import type { Written } from "../ui/annotations/annotations-panel.js";
import type { MarginPlace } from "../ui/annotations/margin.js";
import type { PreviewLoaders } from "../ui/reading/preview.js";
import type { AttachedImages } from "../view-model/attached-images.js";
import type { MeSource } from "../view-model/awaiting-index.js";
import type { OwnSignature } from "../view-model/own-signature.svelte.js";
import { SetAside } from "../view-model/set-aside.js";
import { persistLocally, resumeFrom } from "./local-persistence.js";
import { type WiredClient, wireClient } from "./wire-client.js";

const HISTORY_MERGE_SECONDS = 60;

/** Whether this page keeps the document on the device (ADR-0022):
 * `persisted`, or why not. */
export type LocalStatus =
  | "persisted"
  | "other-tab"
  | "unreadable"
  | "unavailable";

export interface OpenedDocument {
  client: WiredClient;
  connection: DocumentConnection;
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  /** Tell it when the pseudonym changes. */
  registration: Registration;
  /** Who else is here (ADR-0025): tell it when the pseudonym changes, and
   * `leave` when the page closes. */
  presence: Presence;
  /** A Loro panic poisoned a document (docs/phase-9-durcissement.md, L4): stops
   * everything — connection, local saves, presence —
   * and calls `onFatal` once. The transport calls it on a panic at import;
   * the page, on one that surfaces elsewhere. */
  halt(error: unknown): void;
  /** Its view closes while its process lives on: leaves at once for the others,
   * saves what changed and waits
   * for it, disconnects, then lets the local record's lock go (NE6); nothing
   * after, not even a panic. After a halt, only lets
   * the lock go. */
  close(): Promise<void>;
  /** Calls `told` at each import from the server — one push, or a whole
   * history reply —, right before it, its text changed or not (the plugin's
   * export); returns how to stop. */
  onImport(told: (channel: "content" | "annotations") => void): () => void;
  /** Calls `told` at each ack of a frame of this client's (a reply then
   * published may notify, O-41); returns how to stop. */
  onAcked(told: () => void): () => void;
}

/** Opens a document the way the page does: wires a client
 * (`wireClient`), then connects it to the server on the three channels.
 * Resolves once every channel's history has been imported. Shared by
 * `main.ts` and the bench, so that the bench times the page's own path. */
export async function openDocument(options: {
  url: string;
  documentId: string;
  key: CryptoKey;
  credentials: { role: Role; secret: Uint8Array };
  /** The server closed the connection for good once it was up. */
  onRefused?: (code: number) => void;
  /** See `ConnectOptions`. */
  pendingEditSecret?: Uint8Array;
  onRenewed?: (editSecret: Uint8Array) => void;
  /** See `ConnectOptions`. */
  onExpiry?: (expiresAt: number | null) => void;
  onInvalidEntry?: () => void;
  /** See `OpenedDocument.halt`. */
  onFatal?: (error: unknown) => void;
  editorParent: Element;
  panelParent: Element;
  /** See `wireClient`. */
  modesParent?: Element;
  filesParent?: Element;
  margin?: MarginPlace;
  /** Read at each action: the pseudonym may change. */
  author: () => string;
  /** See `wireClient`. */
  livePreview?: boolean;
  editor?: EditorFactory;
  preferences?: Storage | undefined;
  /** See `wireClient`. */
  mac?: boolean;
  onHelp?: () => void;
  trace?: boolean;
  socketFactory?: SocketFactory;
  /** For the tests: what the connection and the local saves have in
   * progress, counted. */
  activity?: Parameters<typeof connectDocument>[0]["activity"];
  /** See `wireClient`. */
  previewLoaders?: Partial<PreviewLoaders>;
  /** Runs once the client is wired, before connecting. */
  onWired?: (client: WiredClient) => void;
  /** Signs what the page writes (docs/protocol/06-identity.md): its
   * annotations, replies, decisions, versions, names and presence.
   * Omitted: nothing signed. */
  signing?: DocumentSigning;
  /** This browser's key and why it doesn't carry the name. */
  ownSignature?: OwnSignature;
  /** See `wireClient`. */
  onWritten?: (written: Written) => void;
  /** Who « I » am, for what awaits my reply (ADR-0050 §2). */
  me?: MeSource;
  /** See `wireClient`. */
  attachedImages?: AttachedImages;
  /** Keep the document on the device (ADR-0022); omitted: nothing kept. */
  local?: {
    indexedDB?: IDBFactory;
    lock?: DocumentLock;
    /** See `storeName`. */
    namespace?: string;
    saveDelayMs?: number;
    onStatus?: (status: LocalStatus) => void;
    /** How many changes only this browser holds, after each save. */
    onUnsent?: (count: number) => void;
    onSaveError?: (error: unknown) => void;
    /** Gets the flush: call it when the page is hidden or closing. */
    flushOn?: (flush: () => void) => void;
  };
}): Promise<OpenedDocument> {
  const { local } = options;
  const localState = local
    ? await openLocalState({
        documentId: options.documentId,
        role: options.credentials.role,
        key: options.key,
        ...(local.indexedDB && { indexedDB: local.indexedDB }),
        ...(local.lock && { lock: local.lock }),
        ...(local.namespace && { namespace: local.namespace }),
      })
    : undefined;
  if (localState) {
    local?.onStatus?.(
      localState.kind === "owner" ? "persisted" : localState.kind,
    );
  }
  const owner = localState?.kind === "owner" ? localState : undefined;
  const record = owner?.record;

  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  const docs = { content: contentDoc, annotations: annotationsDoc };
  for (const doc of [contentDoc, annotationsDoc]) {
    // The history's dates, and its changes: a peer's commits within a
    // minute merge into one (Loro's default is 1 000 s, too coarse to cut at a
    // pause of a few minutes).
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(HISTORY_MERGE_SECONDS);
  }
  // Before the editor exists: it opens on the stored state (ADR-0022).
  for (const stored of record?.channels ?? []) {
    docs[stored.channel].import(stored.snapshot);
  }
  const confirmed: ConfirmedRecord[] = [...(record?.decisions.confirmed ?? [])];
  const setAside = new SetAside(record?.setAside);
  // Before the connection exists: its callbacks feed it (ADR-0025).
  const presence = new Presence({
    doc: contentDoc,
    name: () => options.author(),
    publish: (state) => connection?.publishPresence(state),
    onTrap: (error) => halt(error), // phase 9, R3
    ...(options.signing && { seal: presenceSealer(options.signing) }),
  });
  const acked = new Set<() => void>();
  let persistence: ReturnType<typeof persistLocally> | undefined;
  let connection: DocumentConnection | undefined;
  let halted = false;
  // Decisions still being signed never leave once closed: set once the
  // client exists (a halt may come while it is being wired).
  let closeDecisions = () => {};
  // Phase 9, analysis L4: once, whoever saw the panic first. The stored record
  // stays the last good one: nothing is saved from a poisoned document.
  const halt = (error: unknown) => {
    if (halted) return;
    halted = true;
    connection?.close();
    persistence?.close();
    presence.destroy();
    closeDecisions();
    options.onFatal?.(error);
  };
  let released = false;
  const close = async () => {
    if (!halted) {
      halted = true;
      presence.leave();
      closeDecisions();
      await persistence?.drain();
      connection?.close();
      persistence?.close();
      presence.destroy();
    }
    if (released) return;
    released = true;
    owner?.release();
  };
  const unsent: Uint8Array[] = []; // before the connection exists
  const importing = new Set<(channel: "content" | "annotations") => void>();
  const client = wireClient({
    contentDoc,
    annotationsDoc,
    editorParent: options.editorParent,
    panelParent: options.panelParent,
    ...(options.modesParent && { modesParent: options.modesParent }),
    ...(options.filesParent && { filesParent: options.filesParent }),
    ...(options.margin && { margin: options.margin }),
    preferences: options.preferences,
    ...(options.mac !== undefined && { mac: options.mac }),
    ...(options.onHelp && { onHelp: options.onHelp }),
    author: options.author,
    documentId: options.documentId,
    publishDecision: (record) => {
      if (connection) connection.publishDecision(record);
      else unsent.push(record);
      persistence?.changed();
    },
    role: options.credentials.role,
    // The connection exists before any history is imported (onConnection
    // below): an adopted change always reaches it in order (R-A1).
    adopt: (change) => connection?.adopt("content", change),
    ...(options.trace !== undefined && { trace: options.trace }),
    ...(options.livePreview !== undefined && {
      livePreview: options.livePreview,
    }),
    ...(options.previewLoaders && { previewLoaders: options.previewLoaders }),
    ...(options.editor && { editor: options.editor }),
    onTrap: (error) => halt(error), // phase 9, R3
    ...(options.signing && { signing: options.signing }),
    ...(options.ownSignature && { ownSignature: options.ownSignature }),
    ...(options.onWritten && { onWritten: options.onWritten }),
    setAside,
    ...(options.me && { me: options.me }),
    ...(options.attachedImages && { attachedImages: options.attachedImages }),
  });
  closeDecisions = () => client.decisions.close();
  if (confirmed.length > 0) client.confirm(confirmed.slice());
  attachRemoteCursors(client.editor.view, presence, client.index);
  if (mayPublish(options.credentials.role, "presence")) {
    // A reader stays invisible: it never has a state to send.
    const { view } = client.editor;
    const follow = () => {
      const { anchor, head } = view.state.selection.main;
      presence.setSelection(anchor, head);
    };
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          // The user's own moves and typing; a remote change (marked
          // `"set"` too) moves the text under the cursor, not the cursor
          // in it (Loro cursors).
          const own = update.transactions.some(
            (transaction) =>
              transaction.selection !== undefined ||
              (transaction.annotation(Transaction.userEvent) !== undefined &&
                !transaction.annotation(Transaction.remote)),
          );
          if (own) follow();
        }),
      ),
    });
    follow();
  }
  const registration = registerOnFirstEdit({
    contentDoc,
    annotationsDoc,
    channels: (["content", "annotations"] as const).filter((channel) =>
      mayPublish(options.credentials.role, channel),
    ),
    author: options.author,
    ...(options.signing && {
      seal: (peers: readonly string[], name: string) =>
        sealPeers(options.signing, peers, name),
    }),
  });
  options.onWired?.(client);

  connection = await connectDocument({
    url: options.url,
    documentId: options.documentId,
    key: options.key,
    credentials: options.credentials,
    onConnection: (created) => {
      connection = created;
      for (const record of unsent.splice(0)) created.publishDecision(record);
      if (owner) {
        persistence = persistLocally({
          owner,
          docs,
          connection: created,
          confirmed,
          setAside,
          ...(local?.saveDelayMs !== undefined && {
            delayMs: local.saveDelayMs,
          }),
          ...(local?.onUnsent && { onUnsent: local.onUnsent }),
          ...(local?.onSaveError && { onError: local.onSaveError }),
          ...(options.activity && { activity: options.activity }),
        });
        local?.flushOn?.(persistence.flush);
      }
    },
    ...(record && { resume: resumeFrom(record) }),
    onAcked: () => {
      persistence?.changed();
      for (const told of acked) told();
    },
    ...(options.onRefused && { onRefused: options.onRefused }),
    ...(options.pendingEditSecret && {
      pendingEditSecret: options.pendingEditSecret,
    }),
    ...(options.onRenewed && { onRenewed: options.onRenewed }),
    ...(options.onExpiry && { onExpiry: options.onExpiry }),
    ...(options.onInvalidEntry && { onInvalidEntry: options.onInvalidEntry }),
    onFatal: halt,
    channels: [
      { channel: "content", doc: contentDoc },
      { channel: "annotations", doc: annotationsDoc },
    ],
    decisions: {
      onConfirmed: (batch) => {
        confirmed.push(...batch);
        client.confirm(batch);
        persistence?.changed();
      },
    },
    onImport: (channel, updates) => {
      client.imported(channel, updates);
      for (const told of importing) told(channel);
    },
    presence: {
      receive: (state) => presence.receive(state),
      connected: () => presence.connected(),
    },
    ...(options.socketFactory && { socketFactory: options.socketFactory }),
    ...(options.activity && { activity: options.activity }),
  });
  // The history is in: what arrives from now on is received live (ID-18).
  client.signatures.opened();
  return {
    client,
    connection,
    contentDoc,
    annotationsDoc,
    registration,
    presence,
    halt,
    close,
    onImport(told) {
      importing.add(told);
      return () => importing.delete(told);
    },
    onAcked(told) {
      acked.add(told);
      return () => acked.delete(told);
    },
  };
}
