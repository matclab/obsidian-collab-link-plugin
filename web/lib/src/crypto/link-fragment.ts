import {
  type Role,
  SECRET_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  isRole,
} from "./role-secrets.js";

const KEY_BYTES = 32;

/** What a link carries in its fragment, which never reaches the server
 * (ADR-0019 §2): the content key, for every role, and one role secret. */
export interface LinkFragment {
  /** The content key, base64url. */
  key: string;
  role: Role;
  secret: Uint8Array;
}

/** `#k=<key>&r=<role>.<secret>`. */
export function formatLinkFragment(link: LinkFragment): string {
  return `#k=${link.key}&r=${link.role}.${bytesToBase64Url(link.secret)}`;
}

/** Throws on anything but a well-formed fragment — a link from before
 * phase 5 (`#<key>` alone) included: those documents have no secrets. */
export function parseLinkFragment(urlHash: string): LinkFragment {
  if (!urlHash.startsWith("#")) {
    throw new Error("URL fragment must start with '#'");
  }
  const params = new URLSearchParams(urlHash.slice(1));
  const key = params.get("k");
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("the link carries no content key");
  }
  // AES-256 (docs/protocol/02-links-and-encryption.md, K-2, K-4): a
  // shorter key would import as AES-128 or AES-192.
  if (base64UrlToBytes(key).length !== KEY_BYTES) {
    throw new Error("a content key is 32 bytes");
  }
  const [role, encoded, ...rest] = (params.get("r") ?? "").split(".");
  if (!isRole(role) || encoded === undefined || rest.length > 0) {
    throw new Error("the link carries no role secret");
  }
  const secret = base64UrlToBytes(encoded);
  if (secret.length !== SECRET_BYTES) {
    throw new Error("a role secret is 32 bytes");
  }
  return { key, role, secret };
}
