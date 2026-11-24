/** Which keyring a device holds: one opened by a keyring
 * link (KR-16), or an account's, kept by a gateway (§5.12) — its account
 * (ID-24) and `K_t` (KR-42). How it is kept in `oc:keyring` is this
 * page's, outside the specification. */
import {
  type KeyringCredentials,
  base64UrlToBytes,
  bytesToBase64Url,
  formatAccountKey,
  formatKeyringLink,
  parseKeyringLink,
} from "../../lib/src/index.js";

export interface AccountKeyring {
  gateway: string;
  issuer: string;
  sub: string;
  key: Uint8Array;
  /** Never: a keyring link's alone (`ref.keyringId` reads `undefined`). */
  keyringId?: never;
}

export type KeyringRef = KeyringCredentials | AccountKeyring;

const ACCOUNT_PREFIX = "oc-account:";

export function isAccountKeyring(ref: KeyringRef): ref is AccountKeyring {
  return ref.keyringId === undefined;
}

/** A keyring link's credentials; throws on an account's. */
export function linkOf(ref: KeyringRef): KeyringCredentials {
  if (isAccountKeyring(ref)) throw new Error("an account's keyring");
  return ref;
}

export function formatKeyringRef(ref: KeyringRef): string {
  if (!isAccountKeyring(ref)) return formatKeyringLink(ref);
  return `${ACCOUNT_PREFIX}${JSON.stringify([
    ref.gateway,
    ref.issuer,
    ref.sub,
    bytesToBase64Url(ref.key),
  ])}`;
}

/** Throws on anything but what `formatKeyringRef` writes. */
export function parseKeyringRef(text: string): KeyringRef {
  if (!text.startsWith(ACCOUNT_PREFIX)) return parseKeyringLink(text);
  const value: unknown = JSON.parse(text.slice(ACCOUNT_PREFIX.length));
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((part) => typeof part === "string")
  ) {
    throw new Error("not an account's keyring");
  }
  const [gateway, issuer, sub, key] = value as string[];
  const bytes = base64UrlToBytes(key as string);
  if (bytes.length !== 32) throw new Error("an account's key is 32 bytes");
  return {
    gateway: gateway as string,
    issuer: issuer as string,
    sub: sub as string,
    key: bytes,
  };
}

/** What « Afficher la clé de Mes documents » shows: the keyring link, or the account's
 * key (KR-42). */
export function keyText(ref: KeyringRef): string {
  return isAccountKeyring(ref)
    ? formatAccountKey(ref.key)
    : formatKeyringLink(ref);
}

/** Two accounts' keyrings of different accounts (TR7): one's list never
 * goes into the other's. */
export function otherAccounts(a: KeyringRef, b: KeyringRef): boolean {
  return (
    isAccountKeyring(a) &&
    isAccountKeyring(b) &&
    (a.gateway !== b.gateway || a.issuer !== b.issuer || a.sub !== b.sub)
  );
}

export function sameKeyring(a: KeyringRef, b: KeyringRef): boolean {
  return formatKeyringRef(a) === formatKeyringRef(b);
}
