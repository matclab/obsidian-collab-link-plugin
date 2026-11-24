import { LoroDoc } from "loro-crdt";
import {
  type Annotation,
  type AnnotationIndex,
  type DecisionLog,
  type LocalDecisions,
  listAnnotations,
} from "../../lib/src/annotations/index.js";
import { type WiredClient, wireClient } from "../app/wire-client.js";
import type { DocumentEditor } from "../editor/editor.js";
import type { HistoryView } from "../ui/history/history-view.js";

export type SimChannel = "content" | "annotations";

/** One simulated client: the real editor, decorations and panel wired to
 * its own pair of docs by the page's own `wireClient` — only the network is
 * simulated. */
export interface SimPeer {
  index: number;
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  editor: DocumentEditor;
  /** The shared derived model the peer's views render from. */
  annotationIndex: AnnotationIndex;
  /** The peer's annotations panel. */
  panel: Element;
  /** This peer's confirmed prefix of the decisions journal. */
  log: DecisionLog;
  decisions: LocalDecisions;
  /** Proposals published but not yet journaled (offline, or in flight). */
  outbox: Uint8Array[];
  /** How many journal entries this peer has confirmed. */
  confirmed: number;
  /** The peer's history view; a restore is confirmed. */
  history: HistoryView;
  /** Where the history view is drawn. */
  historyParent: Element;
  /** What awaits the peer's reply, and what it set aside (ADR-0050). */
  awaiting: WiredClient["awaiting"];
  setAside: WiredClient["setAside"];
}

/** A local update as the transport would publish it: one per commit, on one
 * channel, relayed by the server to every other peer. */
export interface SimMessage {
  from: number;
  channel: SimChannel;
  bytes: Uint8Array;
}

/** N peers plus an adversarial network. Loro channels: each message
 * reaches each other peer independently, in any order and at any time (the
 * server relays per channel, and a reconnect replays history per channel,
 * so no cross-message or cross-channel ordering is assumed); Loro buffers
 * an update whose dependencies haven't arrived yet, so any order is a valid
 * delivery. A change an editor imports for an accepted suggestion is
 * relayed as that editor's own content message (adoption, O-31). The
 * decisions channel is modeled as the server sees it
 * (docs/adr/0013-*.md): proposals wait in their peer's outbox until
 * journaled, in one journal order shared by everyone, and each peer
 * confirms a growing prefix of that journal (what a history reply gives
 * it) at its own pace, independently of the Loro channels. */
export class Simulation {
  readonly peers: SimPeer[];
  readonly messages: SimMessage[] = [];
  /** The server's decisions journal: entry i has seq i + 1. */
  readonly journal: Uint8Array[] = [];
  private readonly delivered: Set<number>[];

  constructor(peerCount: number) {
    this.peers = Array.from({ length: peerCount }, (_, index) =>
      this.createPeer(index),
    );
    this.delivered = this.peers.map(() => new Set<number>());
  }

  private createPeer(index: number): SimPeer {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();
    contentDoc.setPeerId(BigInt(index + 1));
    annotationsDoc.setPeerId(BigInt(index + 1));
    contentDoc.subscribeLocalUpdates((bytes) => {
      this.messages.push({ from: index, channel: "content", bytes });
    });
    annotationsDoc.subscribeLocalUpdates((bytes) => {
      this.messages.push({ from: index, channel: "annotations", bytes });
    });
    const outbox: Uint8Array[] = [];
    const panel = document.createElement("div");
    const editorParent = document.createElement("div");
    const client = wireClient({
      contentDoc,
      annotationsDoc,
      editorParent,
      confirm: () => true,
      panelParent: panel,
      author: () => `peer${index}`,
      documentId: "sim",
      publishDecision: (record) => outbox.push(record),
      // O-31: an imported change is published by the editor that imported
      // it, as the transport does — the only way it reaches a peer that
      // can't import it itself (its entry erased by a reviewer).
      adopt: (change) =>
        this.messages.push({ from: index, channel: "content", bytes: change }),
    });
    const { editor, log, decisions } = client;
    return {
      index,
      contentDoc,
      annotationsDoc,
      editor,
      annotationIndex: client.index,
      panel,
      log,
      decisions,
      outbox,
      confirmed: 0,
      history: client.views.history,
      historyParent: editorParent,
      awaiting: client.awaiting,
      setAside: client.setAside,
    };
  }

  /** The server journals `peer`'s oldest unsent proposal. */
  journalNext(peer: number): boolean {
    const record = this.peers[peer]?.outbox.shift();
    if (!record) return false;
    this.journal.push(record);
    return true;
  }

  /** `peer` receives a history reply confirming the journal up to
   * `upTo` entries (clamped). */
  confirm(peer: number, upTo: number): boolean {
    const target = this.peers[peer];
    if (!target) throw new Error("no such peer");
    const end = Math.min(upTo, this.journal.length);
    if (end <= target.confirmed) return false;
    target.log.add(
      this.journal
        .slice(target.confirmed, end)
        .map((record, i) => ({ seq: target.confirmed + i + 1, record })),
    );
    target.confirmed = end;
    return true;
  }

  /** Journals, confirms and delivers everything, letting the effects of
   * confirmed decisions run (a microtask), until nothing moves. */
  async settle(): Promise<void> {
    for (let round = 0; ; round++) {
      if (round > 100) throw new Error("the simulation never settles");
      let any = false;
      for (const peer of this.peers) {
        while (this.journalNext(peer.index)) any = true;
      }
      for (const peer of this.peers) {
        if (this.confirm(peer.index, this.journal.length)) any = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const peer of this.peers) {
        if (this.pendingFor(peer.index).length > 0) any = true;
      }
      this.deliverAll();
      if (!any) return;
    }
  }

  /** Indices of messages not yet delivered to `peer` (never its own). */
  pendingFor(peer: number): number[] {
    const pending: number[] = [];
    this.messages.forEach((message, i) => {
      if (message.from !== peer && !this.delivered[peer]?.has(i))
        pending.push(i);
    });
    return pending;
  }

  deliver(peer: number, messageIndex: number): void {
    const message = this.messages[messageIndex];
    const target = this.peers[peer];
    if (!message || !target) throw new Error("no such message or peer");
    this.delivered[peer]?.add(messageIndex);
    const doc =
      message.channel === "content" ? target.contentDoc : target.annotationsDoc;
    doc.import(message.bytes);
  }

  /** Delivers everything until no peer has anything pending — delivering
   * can't create new messages (imports aren't local updates), but loop
   * anyway so the helper stays correct if that ever changes. */
  deliverAll(): void {
    for (;;) {
      let any = false;
      for (const peer of this.peers) {
        for (const i of this.pendingFor(peer.index)) {
          this.deliver(peer.index, i);
          any = true;
        }
      }
      if (!any) return;
    }
  }
}

export function contentOf(peer: SimPeer): string {
  return peer.contentDoc.getText("content").toString();
}

/** A peer's annotations in a canonical, comparable form. */
export function annotationsOf(peer: SimPeer): Omit<Annotation, "createdAt">[] {
  return listAnnotations(peer.contentDoc, peer.annotationsDoc)
    .map(({ createdAt: _createdAt, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
}
