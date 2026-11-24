/** Notifies the recipients of what I write (ADR-0060 §5):
 * a reply once the server acknowledged its frame, a rejection once it won
 * (O-41). Best effort: each object once, in memory only — a page closed
 * or reloaded before forgets it (NQ4) —, nothing after `close` (NP3).
 * The recipients are judged at the time of sending (NP1). */
import type { LoroDoc } from "loro-crdt";
import {
  type LocalDecisions,
  NOTIFICATION_TTL,
  type PushOutcome,
  encodeNotification,
  encryptNotification,
  readAnnotationEntry,
  recipientsOf,
} from "../../lib/src/index.js";
import type { Written } from "../ui/annotations/annotations-panel.js";

export interface NotifierOptions {
  annotationsDoc: LoroDoc;
  documentId: string;
  /** How far the server acked my operations of `peer` on `annotations`. */
  acknowledged(peer: string): number;
  /** Called at each ack of a frame of mine; returns how to stop. */
  onAcked(listener: () => void): () => void;
  decisions: Pick<LocalDecisions, "outcome" | "confirmed" | "subscribe">;
  /** My keys' fingerprints, in hexadecimal (ADR-0050 §2). */
  mine(): ReadonlySet<string>;
  /** The fingerprint of the server's VAPID key (W-65). */
  vapid: Uint8Array;
  /** The document's title, and my name, as shown now. */
  title(): string;
  name(): string;
  post(request: {
    endpoint: string;
    ttl: number;
    payload: Uint8Array;
  }): Promise<PushOutcome>;
  /** For the tests: the steps that wait. */
  recipients?: typeof recipientsOf;
  encrypt?: typeof encryptNotification;
}

interface PendingReply {
  annotationId: string;
  peer: string;
  /** Acknowledged once the server acked `peer` up to here. */
  end: number;
  excerpt: string;
}

export class Notifier {
  private readonly replies = new Map<string, PendingReply>();
  /** Rejections proposed, by annotation, until their decision is known. */
  private readonly rejections = new Set<string>();
  private readonly stops: (() => void)[];
  private closed = false;

  constructor(private readonly options: NotifierOptions) {
    this.stops = [
      options.onAcked(() => this.checkReplies()),
      options.decisions.subscribe(() => this.checkRejections()),
    ];
  }

  /** What the panel wrote (`Written`): kept until it may notify. */
  written(written: Written): void {
    if (this.closed || written.kind === "annotation") return;
    if (written.kind === "rejection") {
      this.rejections.add(written.annotationId);
      this.checkRejections();
      return;
    }
    const { annotationsDoc } = this.options;
    const peer = annotationsDoc.peerIdStr;
    const { draft } = written;
    this.replies.set(draft.id, {
      annotationId: draft.annotationId,
      peer,
      end: annotationsDoc.oplogVersion().get(peer) ?? 0,
      excerpt: draft.fields.body,
    });
    this.checkReplies();
  }

  /** The view closes: nothing more is sent (NP3). */
  close(): void {
    this.closed = true;
    for (const stop of this.stops) stop();
    this.replies.clear();
    this.rejections.clear();
  }

  private checkReplies(): void {
    for (const [id, reply] of this.replies) {
      if (this.options.acknowledged(reply.peer) < reply.end) continue;
      this.replies.delete(id); // once (NP2)
      void this.send(reply.annotationId, { reply: id }, reply.excerpt);
    }
  }

  private checkRejections(): void {
    const { decisions, annotationsDoc } = this.options;
    for (const annotationId of this.rejections) {
      const outcome = decisions.outcome(annotationId);
      if (outcome === undefined || outcome.kind === "pending") continue;
      this.rejections.delete(annotationId);
      const won =
        outcome.kind === "won" &&
        decisions.confirmed(annotationId, "suggestion")?.decision === "reject";
      if (!won) continue;
      const entry = readAnnotationEntry(annotationsDoc, annotationId);
      void this.send(annotationId, "rejection", entry?.fields.note ?? "");
    }
  }

  private async send(
    annotationId: string,
    of: { reply: string } | "rejection",
    excerpt: string,
  ): Promise<void> {
    const o = this.options;
    const recipients = await (o.recipients ?? recipientsOf)({
      annotationsDoc: o.annotationsDoc,
      documentId: o.documentId,
      annotationId,
      of,
      mine: o.mine(),
      vapid: o.vapid,
    });
    const message = encodeNotification({
      kind: of === "rejection" ? "rejected" : "reply",
      doc: o.documentId,
      annotation: annotationId,
      title: o.title(),
      name: o.name(),
      excerpt,
    });
    for (const { fields } of recipients) {
      if (this.closed) return;
      let payload: Uint8Array;
      try {
        payload = await (o.encrypt ?? encryptNotification)(message, fields);
      } catch {
        continue; // a `p256dh` that isn't a point: that one only
      }
      if (this.closed) return;
      await o.post({
        endpoint: fields.endpoint,
        ttl: NOTIFICATION_TTL,
        payload,
      });
    }
  }
}
