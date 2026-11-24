/** Role secrets (ADR-0019 §2): one random edit secret per document, the
 * read and suggest secrets derived from it by HKDF — one way, so an editor
 * recomputes the three links from its own, and a reader or reviewer climbs
 * to nothing. The server only ever gets their verifiers (a hash), when a
 * document is created or its links renewed, and the one secret of a link
 * when it authenticates. Bytes in, bytes out: no knowledge of the protocol
 * nor of the key that encrypts the content, which is another secret. */

export const ROLES = ["read", "suggest", "edit"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return value === "read" || value === "suggest" || value === "edit";
}

export const SECRET_BYTES = 32;

export function generateEditSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function hkdf(edit: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    edit as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    // No salt: the edit secret is already uniform.
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8(info),
    },
    key,
    SECRET_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** The three secrets of a document, from its edit secret. */
export async function deriveRoleSecrets(
  edit: Uint8Array,
): Promise<Record<Role, Uint8Array>> {
  return {
    read: await hkdf(edit, "obsidian-collab/read/v1"),
    suggest: await hkdf(edit, "obsidian-collab/suggest/v1"),
    edit,
  };
}

/** `SHA-256("obsidian-collab/verifier/v1" ‖ 0 ‖ role ‖ 0 ‖ secret)`: what
 * the server stores and compares (`server/auth`). */
export async function verifier(
  role: Role,
  secret: Uint8Array,
): Promise<Uint8Array> {
  const prefix = utf8(`obsidian-collab/verifier/v1\0${role}\0`);
  const message = new Uint8Array(prefix.length + secret.length);
  message.set(prefix, 0);
  message.set(secret, prefix.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message));
}

/** The verifiers of the three links derived from `edit`. */
export async function verifiers(
  edit: Uint8Array,
): Promise<Record<Role, Uint8Array>> {
  const secrets = await deriveRoleSecrets(edit);
  return {
    read: await verifier("read", secrets.read),
    suggest: await verifier("suggest", secrets.suggest),
    edit: await verifier("edit", secrets.edit),
  };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Throws on anything but base64url without padding. */
export function base64UrlToBytes(base64url: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(base64url)) {
    throw new Error("not base64url");
  }
  const binary = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
