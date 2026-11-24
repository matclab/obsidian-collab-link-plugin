/** Alerts of what awaits my reply (ADR-0060 §1, NL1 to NL5): a
 * system notification when an annotation comes to await me while the view
 * isn't looked at, and the count of what awaits me in the tab's title.
 * What to alert of is `AwaitingAlerts`'s; here, when to ask it, and what
 * is shown. One notification per document at a time: a new one replaces
 * it, counting what came in since the view was last looked at; looking at
 * the view closes it. */
import type {
  Annotation,
  AnnotationIndex,
  SignatureIndex,
  SignatureView,
} from "../../../lib/src/index.js";
import { replyKey } from "../../../lib/src/index.js";
import { t } from "../../i18n/index.js";
import type { AwaitingIndex } from "../../view-model/awaiting-index.js";
import { shownName } from "../annotations/card-model.js";
import { AwaitingAlerts } from "./awaiting-alerts.js";

export type AlertPermission = "granted" | "denied" | "default" | "unsupported";

/** What a host gives of its window and its notifications. */
export interface Attention {
  /** The view is looked at: the page visible and focused (the page), its
   * leaf active in a focused window (the plugin). */
  watched(): boolean;
  /** Told when `watched()` may have changed. */
  subscribe(listener: () => void): () => void;
  permission(): AlertPermission;
  /** Asks for the permission: only on a gesture (ADR-0060 §1). */
  request(): Promise<AlertPermission>;
  /** Shows a notification; `tag` replaces the one shown under it. A click
   * brings the view forward, then calls `onClick`. Gives its closing. */
  notify(notification: {
    tag: string;
    title: string;
    body: string;
    onClick: () => void;
  }): () => void;
  /** The tab's title, its count in front (the page; none in the plugin). */
  count?(awaiting: number): void;
}

/** The excerpt's length at most, in characters. */
const EXCERPT = 120;

export function attachAlerts(options: {
  documentId: string;
  awaiting: AwaitingIndex;
  index: AnnotationIndex;
  signatures: SignatureIndex;
  attention: Attention;
  /** The document's title, if it has one. */
  title: () => string | undefined;
  /** Resolved once the history is in and who I am is known (NL1, NV7). */
  opened: Promise<void>;
  /** Makes the annotation the active one, as its card would. */
  show: (id: string) => void;
}): { destroy(): void } {
  const { awaiting, index, signatures, attention } = options;
  const alerts = new AwaitingAlerts();
  /** What was alerted of since the view was last looked at. */
  const unseen: string[] = [];
  let opening = true;
  let closed = false;
  let closeShown: (() => void) | undefined;
  let counted: number | undefined;

  const hide = () => {
    closeShown?.();
    closeShown = undefined;
  };
  const observe = () => {
    if (closed) return;
    const watched = attention.watched();
    const ids = alerts.observe({
      annotations: index.current().annotations,
      awaiting: awaiting.current(),
      opening,
      settled: signatures.current().settled,
      watched,
    });
    const size = awaiting.current().size;
    if (size !== counted) {
      counted = size;
      attention.count?.(size);
    }
    if (watched) {
      unseen.length = 0;
      hide();
      return;
    }
    if (ids.length === 0 || attention.permission() !== "granted") return;
    for (const id of ids) {
      if (!unseen.includes(id)) unseen.push(id);
    }
    const last = ids.at(-1) as string;
    const annotation = index.current().byId.get(last);
    hide();
    closeShown = attention.notify({
      tag: `oc:${options.documentId}`,
      title: options.title() || t().untitled,
      body:
        unseen.length === 1 && annotation
          ? lastEntry(annotation, signatures.current())
          : t().awaitingCount(unseen.length),
      onClick: () => {
        if (!closed) options.show(last);
      },
    });
  };
  const watchedChanged = () => {
    if (closed || !attention.watched()) return;
    unseen.length = 0;
    hide();
  };
  const stops = [
    awaiting.subscribe(observe),
    attention.subscribe(watchedChanged),
  ];
  void options.opened.then(() => {
    opening = false;
    observe();
  });
  observe();
  return {
    destroy() {
      closed = true;
      for (const stop of stops) stop();
      hide();
    },
  };
}

/** « Alice replied: … », or what the annotation says if it has no reply:
 * its last entry, under the name it shows (ID-39). */
function lastEntry(annotation: Annotation, view: SignatureView): string {
  const reply = annotation.replies.at(-1);
  if (reply) {
    const verdict =
      reply.id === undefined
        ? ({ signed: false } as const)
        : view.of("reply", replyKey(annotation.id, reply.id));
    return t().alertReply(
      shownName(reply.author, verdict),
      excerpt(reply.body),
    );
  }
  const name = shownName(
    annotation.author,
    view.of("annotation", annotation.id),
  );
  const text = annotation.body ?? annotation.note;
  return annotation.type === "comment"
    ? t().alertComment(name, excerpt(text ?? ""))
    : t().alertSuggestion(name);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}
