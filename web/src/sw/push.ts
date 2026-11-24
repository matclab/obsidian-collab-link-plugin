/** What the service worker shows of a push message, and where a click
 * goes (ADR-0060 §5, D-43): plain text only; a click opens the document
 * the message names, on this page's own origin — never an address read in
 * the message. Pure. */
import { readNotification } from "../../lib/src/index.js";
import type { Dictionary } from "../i18n/index.js";

export interface Shown {
  title: string;
  body: string;
  /** One notification per document, replaced (as the page's, NL2). */
  tag: string;
  /** The document to open on a click, if the message named one. */
  doc?: string;
}

/** The notification of a message's text, or, for one that isn't of D-43's
 * form, a generic one: a browser shows one anyway (`userVisibleOnly`). */
export function shownOf(
  text: string | undefined,
  dictionary: Dictionary,
): Shown {
  const message = text === undefined ? undefined : readNotification(text);
  if (!message) {
    return {
      title: dictionary.pushGenericTitle,
      body: dictionary.pushGenericBody,
      tag: "oc:push",
    };
  }
  const name = message.name || dictionary.pushSomeone;
  return {
    title: message.title || dictionary.untitled,
    body:
      message.kind === "reply"
        ? dictionary.alertReply(name, message.excerpt)
        : dictionary.pushRejected(name, message.excerpt),
    tag: `oc:${message.doc}`,
    doc: message.doc,
  };
}

/** Where a click goes: the document, by `?doc=` on the worker's own scope
 * (ADR-0045), or the page itself. */
export function clickTarget(scope: string, doc: string | undefined): string {
  const url = new URL(scope);
  if (doc !== undefined && /^[0-9a-f]{32}$/.test(doc)) {
    url.searchParams.set("doc", doc);
  }
  return url.href;
}
