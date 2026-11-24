/** The keyring of an account (docs/protocol/05-keyring.md, §5.12): its
 * key `K_t`, which a person gives a new device (KR-42), a deposit that
 * hands it over (KR-43), and the gateway's API, opened by a bearer token
 * instead of an access secret (KR-39 – KR-41). The token proves the
 * account; `K_t` never leaves the person's devices (KR-17). */
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  KEYRING_LINK_PREFIX,
  decryptKeyring,
  encryptKeyring,
} from "./crypto.js";
import { UnreadableDeposit } from "./pairing.js";
import type { KeyringTransport } from "./sync.js";

const KEY_BYTES = 32;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** `oc-keyring:v1:<K_t>` (KR-42). */
export function formatAccountKey(key: Uint8Array): string {
  return `${KEYRING_LINK_PREFIX}${bytesToBase64Url(key)}`;
}

/** `K_t` of an account's key, white space around it removed; throws on
 * anything else — a keyring link of three parts included (KR-42). */
export function parseAccountKey(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEYRING_LINK_PREFIX)) {
    throw new Error("not an account's key");
  }
  return decodeKey(trimmed.slice(KEYRING_LINK_PREFIX.length));
}

function decodeKey(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) {
    throw new Error("an account's key is 43 base64url characters");
  }
  const key = base64UrlToBytes(text);
  if (key.length !== KEY_BYTES) throw new Error("an account's key is 32 bytes");
  return key;
}

/** The deposit of `key` under the pairing key `pairingKey` (KR-43). */
export function sealAccountPairing(
  pairingKey: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = JSON.stringify({ v: 1, key: bytesToBase64Url(key) });
  return encryptKeyring(pairingKey, new TextEncoder().encode(plaintext));
}

/** The key an account's deposit hands over; rejects anything else with
 * `UnreadableDeposit` (KR-43, as KR-36). */
export async function openAccountPairing(
  pairingKey: Uint8Array,
  deposit: Uint8Array,
): Promise<Uint8Array> {
  try {
    const plaintext = await decryptKeyring(pairingKey, deposit);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("a deposit is a JSON object");
    }
    const { v, key } = value as Record<string, unknown>;
    if (v !== 1) throw new Error("unsupported deposit version");
    if (typeof key !== "string") throw new Error("a deposit has a key");
    return decodeKey(key);
  } catch (error) {
    throw new UnreadableDeposit(error);
  }
}

/** A request the gateway refused for want of a valid token (`401`,
 * KR-39): the copy waits for the next sign-in (TR6). */
export class SignedOut extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOut";
  }
}

/** The bearer header of the token now, or `SignedOut` without one. */
async function bearer(
  token: () => Promise<string | undefined>,
): Promise<string> {
  const value = await token();
  if (!value) throw new SignedOut();
  return `Bearer ${value}`;
}

/** The version of an `ETag` (KR-3), or a rejection. */
function version(response: Response): number {
  const tag = response.headers.get("etag") ?? "";
  const match = /^"(0|[1-9][0-9]{0,15})"$/.exec(tag);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value))
    throw new Error(`unexpected entity tag ${tag}`);
  return value;
}

/** An account's keyring on its gateway (KR-39). `token` is read at each
 * request: one another tab got after a sign-in serves too. A request
 * without a valid token rejects with `SignedOut`; the keyring is never
 * "missing" — it exists from its account's first request. */
export function httpAccountKeyringTransport(
  gatewayBase: string,
  token: () => Promise<string | undefined>,
  fetchFn: Fetch = fetch,
): KeyringTransport {
  const url = `${gatewayBase}/accounts/keyring`;
  const unexpected = (response: Response) =>
    new Error(`unexpected answer of the gateway (${response.status})`);
  return {
    async read() {
      const response = await fetchFn(url, {
        headers: { Authorization: await bearer(token) },
      });
      if (response.status === 401) throw new SignedOut();
      if (response.status !== 200) throw unexpected(response);
      const v = version(response);
      return { version: v, blob: new Uint8Array(await response.arrayBuffer()) };
    },
    async write(expected, blob) {
      const response = await fetchFn(url, {
        method: "PUT",
        headers: {
          Authorization: await bearer(token),
          "If-Match": `"${expected}"`,
          "Content-Type": "application/octet-stream",
        },
        body: blob as BodyInit,
      });
      if (response.status === 401) throw new SignedOut();
      if (response.status === 204) return { written: version(response) };
      if (response.status === 412) return { stale: version(response) };
      throw unexpected(response);
    },
  };
}

/** Leaves a deposit for another device of the same account (KR-41): its
 * id, or `too-many`. Rejects with `SignedOut` without a valid token. */
export async function depositAccountPairing(
  gatewayBase: string,
  token: () => Promise<string | undefined>,
  deposit: Uint8Array,
  fetchFn: Fetch = fetch,
): Promise<{ pairingId: string } | "too-many"> {
  const response = await fetchFn(`${gatewayBase}/accounts/keyring/pairings`, {
    method: "POST",
    headers: {
      Authorization: await bearer(token),
      "Content-Type": "application/octet-stream",
    },
    body: deposit as BodyInit,
  });
  if (response.status === 401) throw new SignedOut();
  if (response.status === 429) return "too-many";
  if (response.status !== 200)
    throw new Error(`a deposit failed (${response.status})`);
  const { pairing_id: pairingId } = (await response.json()) as {
    pairing_id: unknown;
  };
  if (typeof pairingId !== "string" || !/^[0-9a-f]{32}$/.test(pairingId)) {
    throw new Error("the gateway gave no pairing id");
  }
  return { pairingId };
}

/** Takes a deposit of the token's account (KR-41): its bytes, or
 * `missing` — unknown, taken, expired, or another account's. Rejects with
 * `SignedOut` without a valid token. */
export async function takeAccountPairing(
  gatewayBase: string,
  token: () => Promise<string | undefined>,
  pairingId: string,
  fetchFn: Fetch = fetch,
): Promise<Uint8Array | "missing"> {
  const response = await fetchFn(
    `${gatewayBase}/accounts/pairings/${pairingId}/take`,
    { method: "POST", headers: { Authorization: await bearer(token) } },
  );
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404) return "missing";
  if (response.status !== 200)
    throw new Error(`taking a deposit failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
