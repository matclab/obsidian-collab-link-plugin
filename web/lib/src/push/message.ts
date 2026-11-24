/** A notification message (docs/protocol/03-document.md, D-43): what the
 * sender encrypts for each subscription, and what a receiver shows. Pure. */

export interface NotificationMessage {
  kind: "reply" | "rejected";
  /** The document's identifier (W-3). */
  doc: string;
  /** The annotation replied to, or the suggestion rejected. */
  annotation: string;
  /** The document's title as the sender shows it; maybe empty. */
  title: string;
  /** The name the sender signs with. */
  name: string;
  /** The beginning of the reply's text, or of the suggestion's. */
  excerpt: string;
}

/** Each text's limit, in UTF-16 code units (D-43). */
export const NOTIFICATION_LIMITS = {
  title: 100,
  name: 64,
  excerpt: 200,
} as const;

/** U+0000 – U+001F and U+007F – U+009F (C0, DEL, C1). */
const isControl = (unit: number) =>
  unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f);
/** A surrogate without its pair. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const DOCUMENT_ID = /^[0-9a-f]{32}$/;

/** `text` as a sender writes it (D-43): control characters as spaces,
 * lone surrogates as U+FFFD, shortened to `limit` code units without
 * splitting a pair. */
export function notificationText(text: string, limit: number): string {
  let clean = "";
  for (const char of text.replace(LONE_SURROGATE, "\ufffd")) {
    clean += isControl(char.charCodeAt(0)) ? " " : char;
  }
  if (clean.length <= limit) return clean;
  const cut = clean.charCodeAt(limit - 1);
  // A high surrogate last: its pair would be split.
  const end = cut >= 0xd800 && cut <= 0xdbff ? limit - 1 : limit;
  return clean.slice(0, end);
}

/** The message's JSON (D-43), its texts as a sender writes them. */
export function encodeNotification(message: NotificationMessage): string {
  return JSON.stringify({
    v: 1,
    kind: message.kind,
    doc: message.doc,
    annotation: message.annotation,
    title: notificationText(message.title, NOTIFICATION_LIMITS.title),
    name: notificationText(message.name, NOTIFICATION_LIMITS.name),
    excerpt: notificationText(message.excerpt, NOTIFICATION_LIMITS.excerpt),
  });
}

const isText = (value: unknown): value is string => typeof value === "string";

/** A received message, or `undefined` if it isn't one this client shows
 * (D-43): not JSON, not an object, another `v`, a field missing or of
 * another type. Unknown fields are ignored. Never throws. */
export function readNotification(
  text: string,
): NotificationMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { v, kind, doc, annotation, title, name, excerpt } = value as Record<
    string,
    unknown
  >;
  if (
    v !== 1 ||
    (kind !== "reply" && kind !== "rejected") ||
    !isText(doc) ||
    !DOCUMENT_ID.test(doc) ||
    !isText(annotation) ||
    !isText(title) ||
    !isText(name) ||
    !isText(excerpt)
  ) {
    return undefined;
  }
  return { kind, doc, annotation, title, name, excerpt };
}
