// An address that names a document without its key (docs/phase-19-liens.md,
// decision 5): `?doc=<id>`, as a link between documents
// writes it (ADR-0045 §2). Its link can only come from « Mes documents »:
// this device's copy first, then the list synced. Nothing is written.
import type { KeyringSession } from "../keyring/session.js";

export type ListAnswer =
  | { kind: "found"; link: string }
  /** No list on this device. */
  | { kind: "no-list" }
  /** Not in the list, synced: the document isn't one of this person's. */
  | { kind: "absent" }
  /** Not in this device's copy, and the list couldn't be synced. */
  | { kind: "unchecked" };

/** The link of `documentId` on this page's server, `origin`, in `session`'s
 * list now; the highest role's (KR-22). */
function inList(
  session: KeyringSession,
  documentId: string,
  origin: string,
): string | undefined {
  return session.entries().find((entry) => {
    if (entry.documentId !== documentId) return false;
    try {
      return new URL(entry.link).origin === origin;
    } catch {
      return false;
    }
  })?.link;
}

/** Where to find the link of `documentId`: in this device's copy, else
 * once the list is synced (cases 1 to 4 of analysis 19b). */
export async function linkFromList(
  session: KeyringSession | undefined,
  documentId: string,
  origin: string,
): Promise<ListAnswer> {
  if (!session) return { kind: "no-list" };
  const here = inList(session, documentId, origin);
  if (here) return { kind: "found", link: here };
  const status = await session.sync();
  const synced = inList(session, documentId, origin);
  if (synced) return { kind: "found", link: synced };
  return { kind: status === "synced" ? "absent" : "unchecked" };
}

/** Whether `hash` names no key at all: empty, or `h` alone (ADR-0045
 * §2). Any other fragment is a link, broken or not (K-2). */
export function isKeyless(hash: string): boolean {
  const names = [...new URLSearchParams(hash.replace(/^#/, "")).keys()];
  return names.every((name) => name === "h");
}

/** `href` without `h` in its fragment (ADR-0045 §2): a heading to go to,
 * never kept in the address nor in a link given or kept. */
export function withoutHeading(href: string): {
  href: string;
  heading: string | undefined;
} {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.slice(1));
  const heading = params.get("h") ?? undefined;
  if (heading === undefined) return { href, heading };
  // The fragment rebuilt only when `h` was there: a link as given, else.
  params.delete("h");
  const rest = params.toString();
  url.hash = rest === "" ? "" : `#${rest}`;
  return { href: url.href, heading: heading === "" ? undefined : heading };
}
