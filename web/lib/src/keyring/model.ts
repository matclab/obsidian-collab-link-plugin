/** The keyring's plaintext: a Loro document of root maps, one per field,
 * the links keyed by their secret (docs/protocol/05-keyring.md, §5.7). Pure: no
 * network, no storage, no clock (callers pass the time). The state of a
 * document is derived from its links and the secrets refused, never
 * written (KR-22, TR4). */
import { LoroDoc, type LoroMap } from "loro-crdt";
import { parseLinkFragment } from "../crypto/link-fragment.js";
import { type Role, bytesToBase64Url } from "../crypto/role-secrets.js";

export type KeyringState = "ok" | "renewed" | "deleted";

/** A document of the keyring (KR-21). */
export interface KeyringEntry {
  documentId: string;
  state: KeyringState;
  /** The role of `link`. */
  role: Role;
  /** The current link (KR-22, 3); for a renewed or deleted document, its
   * link of the highest role. */
  link: string;
  title: string | null;
  openedAt: number | null;
  createdHere: boolean;
  excluded: boolean;
}

/** Highest first (KR-22). */
const ROLE_ORDER: Record<Role, number> = { edit: 0, suggest: 1, read: 2 };
const FIELDS = ["title", "opened", "created", "deleted", "excluded"] as const;

/** A new, empty keyring. */
export function newKeyringDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.getMap("meta").set("v", 1);
  doc.commit();
  return doc;
}

/** The document id and the role secret of a link, or `null` for a link
 * that isn't well formed (K-2). */
function readLink(
  link: unknown,
): { documentId: string; role: Role; secret: string } | null {
  if (typeof link !== "string") return null;
  try {
    const url = new URL(link);
    // Shown to be opened (KR-21): never a link that runs something.
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const documentId = url.searchParams.get("doc");
    if (!documentId) return null;
    const { role, secret } = parseLinkFragment(url.hash);
    return { documentId, role, secret: bytesToBase64Url(secret) };
  } catch {
    return null;
  }
}

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

interface KeyringLink {
  secret: string;
  link: string;
  role: Role;
  seen: number | null;
  refused: boolean;
}

/** KR-22: by role, then `seen` (greater first, absent last), then secret. */
function compareLinks(a: KeyringLink, b: KeyringLink): number {
  return (
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
    (b.seen ?? Number.NEGATIVE_INFINITY) -
      (a.seen ?? Number.NEGATIVE_INFINITY) ||
    (a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0)
  );
}

/** The links of the keyring, by document (KR-21). */
function linksByDocument(doc: LoroDoc): Map<string, KeyringLink[]> {
  const failed = doc.getMap("failed");
  const seen = doc.getMap("seen");
  const byDocument = new Map<string, KeyringLink[]>();
  for (const [secret, value] of doc.getMap("links").entries()) {
    const read = readLink(value);
    if (!read || read.secret !== secret) continue;
    const links = byDocument.get(read.documentId) ?? [];
    links.push({
      secret,
      link: value as string,
      role: read.role,
      seen: integer(seen.get(secret)),
      refused: failed.get(secret) === read.documentId,
    });
    byDocument.set(read.documentId, links);
  }
  return byDocument;
}

/** The documents of the keyring, by id (KR-21, KR-22). */
export function listKeyring(doc: LoroDoc): KeyringEntry[] {
  const map = (name: string): LoroMap => doc.getMap(name);
  const byDocument = linksByDocument(doc);
  const entries: KeyringEntry[] = [];
  for (const documentId of [...byDocument.keys()].sort()) {
    const links = (byDocument.get(documentId) ?? []).sort(compareLinks);
    const first = links[0];
    if (!first) continue;
    const current = links.find((l) => !l.refused);
    const deleted = integer(map("deleted").get(documentId)) !== null;
    const shown = (!deleted && current) || first;
    const title = map("title").get(documentId);
    entries.push({
      documentId,
      state: deleted ? "deleted" : current ? "ok" : "renewed",
      role: shown.role,
      link: shown.link,
      title: typeof title === "string" ? title : null,
      openedAt: integer(map("opened").get(documentId)),
      createdHere: map("created").get(documentId) === true,
      excluded: integer(map("excluded").get(documentId)) !== null,
    });
  }
  return entries;
}

/** Adds `link` under its secret, seen at `at` (KR-23: after the server
 * accepted it, when the user gives it, or a rotation's new link before
 * it is sent). An excluded document isn't added back unless `explicit`
 * (KR-24). Returns whether it was written. */
export function rememberLink(
  doc: LoroDoc,
  link: string,
  options: { at: number; explicit?: boolean },
): boolean {
  const read = readLink(link);
  if (!read) return false;
  const excluded = doc.getMap("excluded");
  if (excluded.get(read.documentId) !== undefined) {
    if (!options.explicit) return false;
    excluded.delete(read.documentId);
  }
  const links = doc.getMap("links");
  if (links.get(read.secret) !== link) links.set(read.secret, link);
  const seen = doc.getMap("seen");
  const before = integer(seen.get(read.secret));
  if (before === null || before < options.at) seen.set(read.secret, options.at);
  doc.commit();
  return true;
}

/** The document was opened, at `at` (ms), with this title if known. */
export function noteOpened(
  doc: LoroDoc,
  documentId: string,
  at: number,
  title?: string,
): void {
  doc.getMap("opened").set(documentId, at);
  if (title !== undefined && doc.getMap("title").get(documentId) !== title) {
    doc.getMap("title").set(documentId, title);
  }
  doc.commit();
}

/** Created on one of the person's devices. */
export function noteCreated(doc: LoroDoc, documentId: string): void {
  doc.getMap("created").set(documentId, true);
  doc.commit();
}

/** The server refused this link's secret (`4401`), or revoked it
 * (`4410`, links renewed): KR-23. */
export function noteRefused(doc: LoroDoc, link: string): void {
  const read = readLink(link);
  if (!read) return;
  doc.getMap("failed").set(read.secret, read.documentId);
  doc.commit();
}

/** The document was found deleted (`4404`), at `at` (ms). */
export function noteDeleted(
  doc: LoroDoc,
  documentId: string,
  at: number,
): void {
  if (doc.getMap("deleted").get(documentId) === undefined) {
    doc.getMap("deleted").set(documentId, at);
    doc.commit();
  }
}

/** The user removes the document (KR-23): from every map keyed by its
 * id, and the links, times and refusals that name it. */
export function removeDocument(doc: LoroDoc, documentId: string): void {
  for (const name of FIELDS) {
    const map = doc.getMap(name);
    if (map.get(documentId) !== undefined) map.delete(documentId);
  }
  const links = doc.getMap("links");
  const seen = doc.getMap("seen");
  const failed = doc.getMap("failed");
  for (const [secret, value] of links.entries()) {
    if (readLink(value)?.documentId !== documentId) continue;
    links.delete(secret);
    if (seen.get(secret) !== undefined) seen.delete(secret);
  }
  for (const [secret, value] of failed.entries()) {
    if (value === documentId) failed.delete(secret);
  }
  doc.commit();
}

/** « Ne pas garder ce document » (KR-24): removed, and not added back. */
export function excludeDocument(
  doc: LoroDoc,
  documentId: string,
  at: number,
): void {
  removeDocument(doc, documentId);
  doc.getMap("excluded").set(documentId, at);
  doc.commit();
}

/** A stored plaintext as a keyring, or `null` if Loro can't read it: it
 * is imported into a fresh document first (KR-26). */
export function readKeyringPlaintext(plaintext: Uint8Array): LoroDoc | null {
  try {
    const doc = new LoroDoc();
    doc.import(plaintext);
    return doc;
  } catch {
    return null;
  }
}
