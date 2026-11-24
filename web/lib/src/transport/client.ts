import type { PeerID } from "loro-crdt";
import {
  DEFAULT_COMPACTION_THRESHOLD,
  shouldCompact,
} from "../compaction/policy.js";
import { decrypt, encrypt } from "../crypto/aead.js";
import { count, span } from "../perf/index.js";
import {
  type ChannelRuntime,
  freezeIfPending,
  persistChannel,
  restoreChannel,
} from "./channel-state.js";
import type {
  Activity,
  ConnectOptions,
  DocumentConnection,
} from "./connection.js";
import { isWasmTrap } from "./fatal.js";
import {
  type ConfirmedRecord,
  confirmedBatch,
  groupReply,
} from "./history-reply.js";
import {
  addPending,
  importHistory,
  stillPending,
  updateKind,
} from "./import-history.js";
import { fitting, markAcked, ownSpans } from "./own-operations.js";
import { AckQueue, JoinQueue } from "./pairing.js";
import {
  type ChannelName,
  CloseCode,
  FRAME_OVERHEAD,
  type HistoryEntry,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeServerText,
  encodeAuthMessage,
  encodeCompactMessage,
  encodeDeleteMessage,
  encodeExpireMessage,
  encodeFrame,
  encodeJoinMessage,
  encodeRotateMessage,
  mayCompact,
  mayDelete,
  mayPublish,
} from "./protocol.js";
import { ReconnectPolicy } from "./reconnect.js";
import { RejoinCoalescer } from "./rejoin.js";
import { type SocketLike, realWebSocketFactory } from "./socket.js";

const RECONNECT_DELAY_MS = 500;
/** Compactions deferred in a row because an operation stays pending,
 * before compacting anyway (R-A3, docs/phase-5-modele-acces.md step 2). */
const PENDING_COMPACTION_ATTEMPTS = 3;

/** The server closed the connection for good (ADR-0019 §4): the client
 * doesn't reconnect. */
export class ConnectionRefused extends Error {
  constructor(readonly code: number) {
    super(`connection refused by the server (${code})`);
  }
}

/** The secret travels on every connection (ADR-0019 §3): only over TLS,
 * except to this very machine. */
export function assertSecureUrl(url: string): void {
  const { protocol, hostname } = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (protocol === "ws:" && !local) {
    throw new Error(
      `refusing ${url}: the link's secret needs TLS (wss://) off localhost`,
    );
  }
}

export type {
  Activity,
  ChannelConnection,
  ConnectOptions,
  DecisionsConnection,
  DocumentConnection,
  TransportState,
} from "./connection.js";
export type { ChannelState } from "./channel-state.js";
export type { ConfirmedRecord } from "./history-reply.js";

const NO_ACTIVITY: Activity = { begin() {}, end() {} };

const DEFAULT_PUBLISH_INTERVAL_MS = 100;

export async function connectDocument(
  options: ConnectOptions,
): Promise<DocumentConnection> {
  const {
    url,
    documentId,
    key,
    credentials,
    onRefused,
    onRenewed,
    onExpiry,
    presence,
    onConnection,
    onInvalidEntry,
    onFatal,
    channels,
    decisions,
    onImport,
    socketFactory = realWebSocketFactory,
    compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
    publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS,
    reconnectDelayMs = RECONNECT_DELAY_MS,
    maxMessageBytes = MAX_MESSAGE_BYTES,
    activity = NO_ACTIVITY,
    resume,
    onAcked,
  } = options;
  assertSecureUrl(url);
  const { role } = credentials;
  // The secret the next connection authenticates with, and the one kept
  // from a rotation until it has opened a connection (R-B4).
  let secret = credentials.secret;
  let pendingSecret = role === "edit" ? options.pendingEditSecret : undefined;
  let rotating:
    | { resolve: () => void; reject: (error: Error) => void }
    | undefined;
  let settingExpiry:
    | {
        resolve: (expiresAt: number | null) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  /** Runs `work`, counted as activity until it settles. */
  async function busy<T>(work: () => Promise<T>): Promise<T> {
    activity.begin();
    try {
      return await work();
    } finally {
      activity.end();
    }
  }
  /** `setTimeout`, counted as activity until it fires. */
  function later(
    callback: () => void,
    ms: number,
  ): ReturnType<typeof setTimeout> {
    activity.begin();
    return setTimeout(() => {
      activity.end();
      callback();
    }, ms);
  }

  const runtimes = channels.map(({ channel, doc }) =>
    restoreChannel(
      channel,
      doc,
      resume?.channels.find((state) => state.channel === channel),
    ),
  );
  const runtimeByChannel = new Map<ChannelName, ChannelRuntime>(
    runtimes.map((runtime) => [runtime.channel, runtime]),
  );

  // The authenticated connection, the only one anything is sent on;
  // `current` is the one being opened or authenticated, until it is.
  let socket: SocketLike | undefined;
  let current: SocketLike | undefined;
  // Closed by the caller, or refused for good by the server.
  let stopped = false;
  const reconnect = new ReconnectPolicy(reconnectDelayMs);
  // Acks pair with frames by position (pairing.ts, W-47).
  const acks = new AckQueue();

  // Doc-level (not `getText("content")`-level): a channel's data isn't
  // always a LoroText — annotations/model.ts stores its data in a LoroMap.
  // `doc.subscribe` fires for a local batch on *any* container, so publish
  // triggers correctly regardless of the channel's own container shape.
  const unsubscribes = runtimes.map((runtime) =>
    runtime.doc.subscribe((batch) => {
      if (batch.by !== "local") return;
      runtime.ownPeers.add(runtime.doc.peerIdStr);
      schedulePublish(runtime);
    }),
  );

  // Publishes at the next turn of the event loop — so that commits made in
  // one go leave together — or, right after a frame, once
  // `publishIntervalMs` has passed; never while a frame awaits its ack
  // (publishPending schedules again once it's acked).
  function schedulePublish(runtime: ChannelRuntime): void {
    if (!mayPublish(role, runtime.channel)) return; // stays local
    if (runtime.publishing || runtime.publishTimer !== undefined) return;
    if (stopped) return;
    const wait = runtime.lastPublishAt + publishIntervalMs - Date.now();
    runtime.publishTimer = later(
      () => {
        runtime.publishTimer = undefined;
        void publishPending(runtime);
      },
      Math.max(0, wait),
    );
  }

  // Exports and sends this client's own operations on this channel that
  // the server hasn't acked yet — never what it received, which the
  // server already holds (ADR-0015). `ackedOwn` advances only once the
  // frame is acked, so a failed or offline send is retried rather than
  // dropped: after the ack of any frame, and after every history reply
  // (so edits made while offline, docs/phase-1-squelette-vertical.md step
  // 7's "scénario hors-ligne", are flushed once the connection is back).
  async function publishPending(runtime: ChannelRuntime): Promise<void> {
    if (runtime.publishing || stopped || !socket) return;
    // R-A1: its own operations up to an adoption, the adopted change,
    // then what follows (own-operations.ts).
    const head = runtime.adopted[0];
    const spans = ownSpans(runtime, head);
    if (spans.length === 0) {
      if (!head) return; // nothing of ours to send
      runtime.publishing = true;
      runtime.lastPublishAt = Date.now();
      count("publish.adopted");
      const acked = await trySend(runtime.channel, head.change);
      runtime.publishing = false;
      if (!acked) return; // R-A2: the next history reply publishes again
      if (runtime.adopted[0] === head) runtime.adopted.shift();
      onAcked?.();
      schedulePublish(runtime);
      return;
    }
    const { sent, update } = fitting(runtime.doc, spans, maxMessageBytes);
    runtime.publishing = true;
    runtime.lastPublishAt = Date.now();
    count("publish.frame");
    const acked = await trySend(runtime.channel, update);
    runtime.publishing = false;
    if (!acked) return; // the next history reply publishes again
    runtime.opsSinceLastCompaction += markAcked(runtime, sent);
    onAcked?.();
    if (
      mayCompact(role) &&
      shouldCompact(runtime.opsSinceLastCompaction, compactionThreshold)
    ) {
      void triggerCompaction(runtime);
    }
    schedulePublish(runtime); // committed while this frame was in flight
  }

  async function trySend(
    channel: ChannelName,
    update: Uint8Array,
  ): Promise<boolean> {
    if (stopped || !socket) return false;
    if (FRAME_OVERHEAD + update.length > maxMessageBytes) {
      // The server would cut the connection, and this client send it
      // again at every reconnection (O-18): kept, never sent.
      console.error(`a ${channel} frame exceeds the message limit`);
      return false;
    }
    try {
      const encrypted = await busy(() => encrypt(key, update));
      if (stopped || !socket) return false; // dropped while encrypting
      const currentSocket = socket;
      const ackSeq = await new Promise<number | undefined>((resolve) => {
        // Sent first: a socket still connecting throws, and a waiter
        // registered for a frame never sent would take the next frame's
        // ack.
        currentSocket.send(encodeFrame(channel, encrypted));
        acks.push(channel, resolve);
      });
      return ackSeq !== undefined;
    } catch {
      return false; // the socket may have just dropped; the next history reply publishes again
    }
  }

  // Exports a full snapshot of one channel and asks the server to
  // squash that channel's journal up to a point this client has actually
  // been *shown*, via a fresh differential rejoin — never up to a seq it
  // only knows from its own publish ack (`docs/adr/0011-*.md`): an ack
  // proves this client's own op was journaled, not that it has imported
  // concurrently journaled operations from other peers with a lower seq.
  // Reuses the multi-join-per-connection mechanism
  // (`docs/phase-3-second-canal-annotations.md` decision 4) — no new wire
  // message.
  async function triggerCompaction(runtime: ChannelRuntime): Promise<void> {
    if (stopped || !socket) return;
    const currentSocket = socket;
    const sinceSent = runtime.confirmedSeq;
    const maxSeqInReply = await new Promise<number | undefined>((resolve) => {
      joins.push({ channel: runtime.channel, onReplied: resolve });
      currentSocket.send(
        encodeJoinMessage(documentId, runtime.channel, sinceSent),
      );
    });
    // handleMessage already imported this reply's entries (if any) and
    // advanced runtime.confirmedSeq accordingly; an empty reply means
    // nothing changed since sinceSent, which is itself already confirmed.
    const upToSeq = maxSeqInReply ?? sinceSent;
    if (upToSeq === 0 || stopped || !socket) return; // nothing confirmed yet, or dropped mid-rejoin

    // R-A3: an operation still pending after the rejoin would be left out
    // of the snapshot, and its entry dropped. Wait for the next threshold
    // crossing; after a few in a row, what it waits for is not in the
    // journal (an honest writer publishes a dependency first, R-A1), no
    // one can apply it, and compacting anyway loses nothing visible.
    if (stillPending(runtime.doc, runtime.pending)) {
      runtime.deferredCompactions++;
      if (runtime.deferredCompactions < PENDING_COMPACTION_ATTEMPTS) {
        runtime.opsSinceLastCompaction = 0;
        return;
      }
    }
    runtime.deferredCompactions = 0;

    // Full, not shallow (ADR-0017): an operation built on an older state
    // (a frame in flight, a peer offline) must stay importable after it.
    const snapshot = runtime.doc.export({ mode: "snapshot" });
    try {
      const encrypted = await busy(() => encrypt(key, snapshot));
      const message = encodeCompactMessage(
        documentId,
        runtime.channel,
        upToSeq,
        encrypted,
      );
      // Beyond the limit the server would close the connection: the
      // journal stays uncompacted, nothing is lost, and the next threshold
      // crossing tries again.
      if (message.length <= maxMessageBytes) socket.send(message);
      runtime.opsSinceLastCompaction = 0;
    } catch {
      // the socket may have just dropped; this round's compaction is
      // simply skipped — the next threshold crossing will try again.
    }
  }

  // History replies pair with joins by position (pairing.ts).
  const joins = new JoinQueue();

  // Decisions channel state. Its own confirmed cursor, like each Loro
  // channel's, never advanced by an ack: a record pushed to this client (a
  // mere signal, never imported) with a lower seq than one of its acks
  // would be skipped forever by a rejoin from an ack's seq. Only a
  // delivered history reply moves it — the model's `serverJoin` answers
  // `props ∖ known`.
  let decisionsConfirmedSeq = resume?.decisions.cursor ?? 0;
  // Bumped on every new socket: a reply still being decrypted for a dead
  // socket may deliver its (valid) records, but must not drive the
  // coalescer of the new connection.
  let generation = 0;
  let onFirstDecisionsReply: (() => void) | undefined;
  const decisionsOutbox: Uint8Array[] = [...(resume?.decisions.outbox ?? [])];
  let flushingOutbox = false;
  const coalescer = new RejoinCoalescer(() => {
    if (!socket) return;
    const joinGeneration = generation;
    joins.push({
      channel: "decisions",
      onReplied: () => {
        onFirstDecisionsReply?.();
        onFirstDecisionsReply = undefined;
        if (joinGeneration === generation) coalescer.replied();
        void flushDecisionsOutbox();
      },
    });
    socket.send(
      encodeJoinMessage(documentId, "decisions", decisionsConfirmedSeq),
    );
  });

  // Sends queued records in order, one at a time, stopping at the first
  // failure (retried after the next reconnect's decisions reply).
  async function flushDecisionsOutbox(): Promise<void> {
    if (flushingOutbox) return;
    flushingOutbox = true;
    try {
      while (decisionsOutbox.length > 0) {
        const record = decisionsOutbox[0];
        if (!record || !(await trySend("decisions", record))) return;
        decisionsOutbox.shift();
        onAcked?.();
      }
    } finally {
      flushingOutbox = false;
    }
  }

  // Decrypts the whole reply before delivering anything: handleMessage is
  // async, and two replies can be in progress at once (a dead socket's and
  // the new one's). Delivering entry by entry could expose seq 9 before seq
  // 7 — a non-prefix view that may pick the wrong first proposal and apply
  // an irreversible effect. Delivered synchronously, filtered against the
  // cursor: each reply is the complete suffix after a `since` no greater
  // than the cursor, so the union stays a gapless prefix.
  /** `blob` decrypted, or nothing (counted, reported) if it doesn't. */
  async function tryDecrypt(
    channel: ChannelName,
    blob: Uint8Array,
  ): Promise<Uint8Array | undefined> {
    try {
      return await decrypt(key, blob);
    } catch {
      invalidEntry(channel);
      return undefined;
    }
  }

  function invalidEntry(channel: ChannelName): void {
    count("import.invalid");
    onInvalidEntry?.(channel);
  }

  async function deliverDecisionsReply(
    entries: { seq: number; blob: Uint8Array }[],
  ): Promise<void> {
    // An entry that doesn't decrypt is delivered as an empty record, which
    // no proposal decodes from: the union of batches stays a gapless
    // prefix of the journal.
    const decrypted: ConfirmedRecord[] = [];
    for (const entry of entries) {
      decrypted.push({
        seq: entry.seq,
        record:
          (await tryDecrypt("decisions", entry.blob)) ?? new Uint8Array(0),
      });
    }
    const { batch, cursor } = confirmedBatch(decrypted, decisionsConfirmedSeq);
    if (batch.length === 0) return;
    decisionsConfirmedSeq = cursor;
    decisions?.onConfirmed(batch);
  }

  // Resolved by the first connection that gets every history reply — not
  // necessarily the first one: if that one drops before, a reconnect must
  // still let `connectDocument` resolve (the page waits on it to publish
  // decisions clicked meanwhile).
  let ready: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  let isReady = false;
  const firstReady = new Promise<void>((resolve, reject) => {
    ready = () => {
      isReady = true;
      resolve();
    };
    failed = reject;
  });

  /** A Loro panic poisoned a document (phase 9, L4): nothing more is sent,
   * no reconnection; the owner is told once. A connection still opening
   * opens stopped. */
  function fatal(error: unknown): void {
    if (stopped) return;
    stop();
    current?.close();
    onFatal?.(error);
    if (!isReady) ready();
  }

  function stop(): void {
    stopped = true;
    for (const runtime of runtimes) {
      if (runtime.publishTimer === undefined) continue;
      clearTimeout(runtime.publishTimer);
      runtime.publishTimer = undefined;
      activity.end();
    }
    for (const unsubscribe of unsubscribes) unsubscribe();
  }

  // The server sent what this client can't read, or can't pair with a
  // request of its own (docs/protocol/01-wire.md, W-47): the pairing by
  // position can no longer be trusted (ADR-0015 §4). Closing resumes as
  // after a network loss — rejoining from the confirmed cursors and
  // publishing again what wasn't acked —, never final.
  function protocolError(at: SocketLike, why: string): void {
    console.error(`closing the connection: ${why}`);
    if (current === at) at.close();
  }

  function connectOnce(): void {
    const newSocket = socketFactory(url);
    current = newSocket;
    let historyRepliesRemaining = runtimes.length + (decisions ? 1 : 0);
    const replied = () => {
      historyRepliesRemaining--;
      if (historyRepliesRemaining === 0) ready();
    };

    // Nothing but `auth` until the server answers it (ADR-0019 §3).
    const usedSecret = secret;
    newSocket.onopen = () => {
      newSocket.send(encodeAuthMessage(documentId, role, usedSecret));
    };

    const authenticated = () => {
      socket = newSocket;
      if (usedSecret === pendingSecret) {
        pendingSecret = undefined;
        onRenewed?.(usedSecret);
      }
      reconnect.authenticated();
      generation++;
      joins.reset(
        runtimes.map((runtime) => ({
          channel: runtime.channel,
          onReplied: replied,
        })),
      );
      for (const runtime of runtimes) {
        newSocket.send(
          encodeJoinMessage(
            documentId,
            runtime.channel,
            runtime.confirmedSeq > 0 ? runtime.confirmedSeq : undefined,
          ),
        );
      }
      if (decisions) {
        onFirstDecisionsReply = replied;
        coalescer.connected();
      }
    };

    newSocket.onmessage = (event) => {
      const { data } = event;
      if (typeof data === "string") {
        let message: ReturnType<typeof decodeServerText>;
        try {
          message = decodeServerText(data);
        } catch {
          protocolError(newSocket, "a server message this client can't read");
          return;
        }
        if (message.kind === "unknown") return; // a later extension (phase 8, N4)
        if (message.kind === "authenticated") {
          if (message.version !== PROTOCOL_VERSION) {
            // Held to another version than the one asked (phase 8, N2): as if the
            // server had refused it.
            const code = CloseCode.UnsupportedVersion;
            stop();
            newSocket.close();
            if (isReady) onRefused?.(code);
            else failed(new ConnectionRefused(code));
            return;
          }
          authenticated();
          onExpiry?.(message.expiresAt);
          presence?.connected();
          return;
        }
        if (message.kind === "expiry") {
          onExpiry?.(message.expiresAt);
          settingExpiry?.resolve(message.expiresAt);
          settingExpiry = undefined;
          return;
        }
        if (message.kind === "rotated") {
          // The server closed this connection with its reply (ADR-0019
          // §5): nothing sent now would be handled — a second rotation
          // would replace the kept secret with one never registered.
          if (socket === newSocket) socket = undefined;
          rotating?.resolve();
          rotating = undefined;
          return;
        }
        void busy(() => handleText(newSocket, message));
        return;
      }
      void busy(() => handleFrame(data));
    };

    newSocket.onclose = ({ code }) => {
      // Forget a dead socket right away: a send on it is silently lost
      // and never acked, and its ack waiter would be registered after
      // `acks.failAll()` below — left pending forever, it would wedge
      // the decisions outbox for good.
      if (socket === newSocket) socket = undefined;
      if (current === newSocket) current = undefined;
      acks.failAll();
      coalescer.disconnected();
      rotating?.reject(new Error("rotation outcome unknown"));
      rotating = undefined;
      settingExpiry?.reject(new Error("expiry outcome unknown"));
      settingExpiry = undefined;
      if (stopped) return;
      const replaced =
        code === CloseCode.Unauthenticated || code === CloseCode.Revoked;
      if (replaced && pendingSecret && pendingSecret !== usedSecret) {
        secret = pendingSecret; // R-B4, and the requester of a rotation
        later(connectOnce, reconnectDelayMs);
        return;
      }
      const delay = reconnect.delay(code);
      if (delay === undefined) {
        stop();
        if (isReady) onRefused?.(code);
        else failed(new ConnectionRefused(code));
        return;
      }
      later(connectOnce, delay);
    };
  }

  async function handleText(
    from: SocketLike,
    message:
      | { kind: "history"; entries: HistoryEntry[] }
      | { kind: "ack"; channel: ChannelName; seq: number },
  ): Promise<void> {
    {
      if (message.kind === "ack") {
        if (!acks.resolveNext(message.channel, message.seq)) {
          protocolError(from, "an ack of no frame in flight");
          return;
        }
        if (message.channel === "decisions") {
          coalescer.signal(); // our own record: confirmed only by a rejoin
        }
        return;
      }
      const { entries } = message;
      const pendingJoin = joins.shift();
      if (!pendingJoin) {
        protocolError(from, "a history reply to no join");
        return;
      }
      // Only the joined channel's entries (H1): another one's would move
      // that channel's cursor past entries never seen (O-3).
      if (entries.some((entry) => entry.channel !== pendingJoin.channel)) {
        protocolError(from, "a history entry of another channel than its join");
        return;
      }
      if (pendingJoin?.channel === "decisions") {
        try {
          await deliverDecisionsReply(
            entries.filter((entry) => entry.channel === "decisions"),
          );
        } finally {
          // even if a consumer throws: a coalescer stuck "in flight" would
          // never rejoin again
          pendingJoin.onReplied(undefined);
        }
        return;
      }
      // Decrypted in full, then imported in one batch per channel
      // (docs/phase-4ter-*.md, decision 3): one Loro event per channel
      // rather than one per entry, so the page derives and renders once.
      // An entry that doesn't decrypt, or isn't a Loro update, is skipped
      // and reported, but still confirmed: it will never become valid, and
      // must not keep the rest out (decision 10). The cursors move past
      // what was imported or skipped, never past what wasn't seen
      // (docs/adr/0011-*.md).
      const decrypted: {
        runtime: ChannelRuntime;
        seq: number;
        plaintext: Uint8Array | undefined;
      }[] = [];
      for (const entry of entries) {
        const runtime = runtimeByChannel.get(entry.channel);
        if (!runtime) continue; // a channel this connection never joined
        let plaintext = await tryDecrypt(entry.channel, entry.blob);
        if (plaintext && updateKind(plaintext) === "invalid") {
          invalidEntry(entry.channel);
          plaintext = undefined;
        }
        decrypted.push({ runtime, seq: entry.seq, plaintext });
      }
      let maxSeqInReply: number | undefined;
      for (const { runtime, updates, seq } of groupReply(decrypted, runtimes)) {
        if (updates.length > 0) {
          onImport?.(runtime.channel, updates);
          const cursorBefore = runtime.confirmedSeq;
          try {
            importHistory(runtime.doc, updates, runtime.pending, () =>
              invalidEntry(runtime.channel),
            );
          } catch (error) {
            if (!isWasmTrap(error)) throw error;
            fatal(error);
            return;
          }
          freezeIfPending(runtime, cursorBefore);
        }
        maxSeqInReply =
          maxSeqInReply === undefined ? seq : Math.max(maxSeqInReply, seq);
        runtime.confirmedSeq = Math.max(runtime.confirmedSeq, seq);
      }
      pendingJoin?.onReplied(maxSeqInReply);
      const runtime = pendingJoin
        ? runtimeByChannel.get(pendingJoin.channel)
        : undefined;
      if (runtime) schedulePublish(runtime);
    }
  }

  async function handleFrame(data: ArrayBuffer): Promise<void> {
    const frame = decodeFrame(new Uint8Array(data));
    if (!frame) return; // a channel of a later extension (phase 8, N4)
    const { channel, blob } = frame;
    if (channel === "presence") {
      // Not an entry of the document: one that doesn't decrypt is dropped,
      // not counted among the unreadable entries.
      const state = await decrypt(key, blob).catch(() => undefined);
      if (state) presence?.receive(state);
      return;
    }
    if (channel === "decisions") {
      coalescer.signal(); // a signal, never imported (docs/adr/0013-*.md)
      return;
    }
    const runtime = runtimeByChannel.get(channel);
    if (!runtime) return; // a channel this connection never joined
    const plaintext = await tryDecrypt(channel, blob);
    if (!plaintext) return;
    if (updateKind(plaintext) === "invalid") {
      invalidEntry(channel);
      return;
    }
    onImport?.(runtime.channel, [plaintext]);
    count("loro.import");
    try {
      addPending(
        runtime.pending,
        span("import", () => runtime.doc.import(plaintext)),
      );
      freezeIfPending(runtime, runtime.confirmedSeq);
    } catch (error) {
      if (isWasmTrap(error)) fatal(error);
      else invalidEntry(channel);
    }
  }

  const connection: DocumentConnection = {
    adopt(channel, change) {
      const runtime = runtimeByChannel.get(channel);
      if (!runtime || !mayPublish(role, channel)) return;
      const version = runtime.doc.oplogVersion();
      const ownBefore = new Map<PeerID, number>();
      for (const peer of runtime.ownPeers) {
        ownBefore.set(peer, version.get(peer) ?? 0);
      }
      runtime.adopted.push({ change, ownBefore });
      schedulePublish(runtime);
    },
    rotate(next) {
      if (role !== "edit") {
        return Promise.reject(new Error(`a ${role} link cannot rotate`));
      }
      const current = socket;
      if (!current || rotating) {
        return Promise.reject(new Error("not connected, or rotating"));
      }
      pendingSecret = next.secret;
      return new Promise<void>((resolve, reject) => {
        rotating = { resolve, reject };
        current.send(encodeRotateMessage(next.verifiers));
      });
    },
    publishPresence(state) {
      if (!mayPublish(role, "presence") || stopped || !socket) return;
      void busy(async () => {
        const encrypted = await encrypt(key, state);
        // Whichever authenticated connection is up now: no ack to pair.
        if (!stopped) socket?.send(encodeFrame("presence", encrypted));
      });
    },
    deleteDocument() {
      if (!mayDelete(role)) throw new Error(`a ${role} link cannot delete`);
      if (stopped || !socket) throw new Error("not connected");
      socket.send(encodeDeleteMessage(documentId));
      // This connection closes either way (4404, a refusal, or a drop: a
      // message is lost only with its connection): nothing more is sent on
      // it.
      socket = undefined;
    },
    setExpiry(inSeconds) {
      if (!mayDelete(role)) {
        return Promise.reject(new Error(`a ${role} link cannot set an expiry`));
      }
      const current = socket;
      if (stopped || !current || settingExpiry) {
        return Promise.reject(new Error("not connected, or setting"));
      }
      return new Promise<number | null>((resolve, reject) => {
        settingExpiry = { resolve, reject };
        current.send(encodeExpireMessage(documentId, inSeconds));
      });
    },
    publishDecision(record: Uint8Array) {
      if (!mayPublish(role, "decisions")) {
        throw new Error(`a ${role} link cannot decide`);
      }
      decisionsOutbox.push(record);
      void flushDecisionsOutbox();
    },
    acknowledged(channel, peer) {
      const acked = runtimeByChannel.get(channel)?.ackedOwn.get(peer as PeerID);
      return acked ?? 0;
    },
    persisted() {
      return {
        channels: runtimes.map(persistChannel),
        decisions: {
          cursor: decisionsConfirmedSeq,
          outbox: [...decisionsOutbox],
        },
      };
    },
    close() {
      stop();
      current?.close();
    },
  };
  onConnection?.(connection);
  connectOnce();
  await firstReady;
  return connection;
}
