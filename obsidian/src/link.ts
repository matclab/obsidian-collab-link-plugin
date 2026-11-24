import {
  type LinkFragment,
  parseLinkFragment,
} from "../../web/lib/src/index.js";

/** A document's link, read: its server, its document, its key and role. */
export interface DocumentLink {
  /** The server's origin: it serves the page, the API and `/ws` (K-3). */
  apiBase: string;
  documentId: string;
  fragment: LinkFragment;
}

/** Why a pasted text opens nothing: not a document's link; a server
 * reached without TLS (its secret would cross the network in clear); or a
 * fragment without a key or a role secret. */
export type LinkProblem = "not-a-link" | "insecure" | "invalid";

const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

/** Reads a link pasted into the plugin (docs/phase-14-plugin-obsidian.md,
 * decision 9): the page's own (`<page>?doc=<id>#k=…&r=…`), over https, or
 * http to this computer only (as the library's `assertSecureUrl`). */
export function parseDocumentLink(
  text: string,
): { ok: true; link: DocumentLink } | { ok: false; problem: LinkProblem } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, problem: "not-a-link" };
  }
  const documentId = url.searchParams.get("doc");
  const web = url.protocol === "https:" || url.protocol === "http:";
  if (!web || !documentId) return { ok: false, problem: "not-a-link" };
  if (url.protocol === "http:" && !LOCAL.includes(url.hostname)) {
    return { ok: false, problem: "insecure" };
  }
  try {
    const fragment = parseLinkFragment(url.hash);
    return { ok: true, link: { apiBase: url.origin, documentId, fragment } };
  } catch {
    return { ok: false, problem: "invalid" };
  }
}
