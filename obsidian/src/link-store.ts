import { type DocumentLink, parseDocumentLink } from "./link.js";

/** What the plugin uses of `app.secretStorage` (Obsidian 1.11.4). */
export interface SecretStore {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
}

/** A 128-bit FNV-1a hash of `text`, in hexadecimal: synchronous (WebCrypto
 * isn't), for names too long to write out. */
function hash128(text: string): string {
  const prime = 0x0000000001000000000000000000013bn;
  let value = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(text)) {
    value = ((value ^ BigInt(byte)) * prime) & ((1n << 128n) - 1n);
  }
  return value.toString(16).padStart(32, "0");
}

/** A secret's id for `name`: `app.secretStorage` takes lowercase letters,
 * digits and dashes, 64 characters at most. A short lowercase name is
 * written as it is (the server's ids: 32 hexadecimal digits), a short
 * other one in hexadecimal, a long one hashed; each form has its own
 * prefix, so two names never share an id but by a hash's collision. */
export function secretId(kind: string, name: string): string {
  const prefix = `collab-link-${kind}`;
  if (/^[a-z0-9]{1,40}$/.test(name)) return `${prefix}-d-${name}`;
  const hex = Array.from(new TextEncoder().encode(name), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hex.length <= 40) return `${prefix}-x-${hex}`;
  return `${prefix}-h-${hash128(name)}`;
}

/** Secrets kept under the plugin's former name, Collab Notes (renamed
 * Collab Link before any release): one not found under its
 * id is read under its former id, and kept under the new one. The former
 * one is left as it is (the store can't remove a secret). */
export function withFormerIds(secrets: SecretStore): SecretStore {
  const NOW = "collab-link-";
  const FORMER = "collab-notes-";
  return {
    setSecret: (id, secret) => secrets.setSecret(id, secret),
    listSecrets: () => secrets.listSecrets(),
    getSecret(id) {
      const value = secrets.getSecret(id);
      if (value !== null || !id.startsWith(NOW)) return value;
      const former = secrets.getSecret(`${FORMER}${id.slice(NOW.length)}`);
      if (former) secrets.setSecret(id, former);
      return former;
    },
  };
}

/** The documents' links, by document (docs/phase-14-plugin-obsidian.md,
 * decision 5): in `app.secretStorage`, never in the vault nor in
 * `data.json`, which git and a configuration sync carry. */
export class LinkStore {
  constructor(private readonly secrets: SecretStore) {}

  get(documentId: string): DocumentLink | undefined {
    const url = this.secrets.getSecret(secretId("link", documentId));
    if (!url) return undefined;
    const parsed = parseDocumentLink(url);
    return parsed.ok && parsed.link.documentId === documentId
      ? parsed.link
      : undefined;
  }

  /** Keeps `url`, a link to `documentId` (a rotation replaces it). */
  set(documentId: string, url: string): void {
    const parsed = parseDocumentLink(url);
    if (!parsed.ok || parsed.link.documentId !== documentId) {
      throw new Error("not a link to this document");
    }
    this.secrets.setSecret(secretId("link", documentId), url);
  }

  /** "Unlink": the store can't remove a secret, it empties it. */
  forget(documentId: string): void {
    this.secrets.setSecret(secretId("link", documentId), "");
  }
}
