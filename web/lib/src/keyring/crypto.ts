/** The keyring's secrets and its blob (docs/protocol/05-keyring.md, §5.2,
 * §5.5, §5.6): bytes in, bytes out. The access secret `S` proves the
 * keyring to the server, which keeps only its verifier; the key `K_t`
 * encrypts the blob and never leaves the person's devices. */
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";

export const KEYRING_LINK_PREFIX = "oc-keyring:v1:";
const BYTES = 32;
const NONCE_BYTES = 12;

/** What a keyring link carries (KR-16). */
export interface KeyringCredentials {
  keyringId: string;
  /** `S`, the access secret. */
  secret: Uint8Array;
  /** `K_t`, the key of the blob. */
  key: Uint8Array;
}

/** A fresh access secret and key (KR-2, KR-17). */
export function newKeyringSecrets(): { secret: Uint8Array; key: Uint8Array } {
  return {
    secret: crypto.getRandomValues(new Uint8Array(BYTES)),
    key: crypto.getRandomValues(new Uint8Array(BYTES)),
  };
}

/** `oc-keyring:v1:<id>.<S>.<K_t>` (KR-16). */
export function formatKeyringLink(credentials: KeyringCredentials): string {
  const { keyringId, secret, key } = credentials;
  return `${KEYRING_LINK_PREFIX}${keyringId}.${bytesToBase64Url(secret)}.${bytesToBase64Url(key)}`;
}

/** Reads a keyring link, white space around it removed; throws on
 * anything else (KR-16). */
export function parseKeyringLink(text: string): KeyringCredentials {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEYRING_LINK_PREFIX)) {
    throw new Error("not a keyring link");
  }
  const parts = trimmed.slice(KEYRING_LINK_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("a keyring link has three parts");
  const [keyringId = "", secret = "", key = ""] = parts;
  if (!/^[0-9a-f]{32}$/.test(keyringId)) {
    throw new Error("a keyring id is 32 lowercase hexadecimal characters");
  }
  const decode = (value: string) => {
    const bytes = base64UrlToBytes(value);
    if (bytes.length !== BYTES) throw new Error("a keyring secret is 32 bytes");
    return bytes;
  };
  return { keyringId, secret: decode(secret), key: decode(key) };
}

/** The verifier the server keeps for `S` (KR-2): K-8 with the role name
 * `keyring`. */
export async function keyringVerifier(secret: Uint8Array): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(
    "obsidian-collab/verifier/v1\0keyring\0",
  );
  const message = new Uint8Array(prefix.length + secret.length);
  message.set(prefix, 0);
  message.set(secret, prefix.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message));
}

const importKey = (key: Uint8Array, usage: KeyUsage) =>
  crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    usage,
  ]);

/** Nonce, ciphertext and tag (KR-18). */
export async function encryptKeyring(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await importKey(key, "encrypt"),
      plaintext as BufferSource,
    ),
  );
  const blob = new Uint8Array(NONCE_BYTES + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, NONCE_BYTES);
  return blob;
}

/** Rejects a blob that doesn't decrypt under `key` (KR-19). */
export async function decryptKeyring(
  key: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, NONCE_BYTES) },
    await importKey(key, "decrypt"),
    blob.slice(NONCE_BYTES),
  );
  return new Uint8Array(plaintext);
}
