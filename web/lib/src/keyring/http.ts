/** The keyring's API over HTTP (docs/protocol/05-keyring.md, §5.3): the
 * transport `sync.ts` is written against, and creating a keyring. Knows
 * the access secret `S`, never sends `K_t` (KR-17). */
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import { PROTOCOL_VERSION } from "../transport/protocol.js";
import {
  type KeyringCredentials,
  formatKeyringLink,
  keyringVerifier,
  newKeyringSecrets,
} from "./crypto.js";
import type { KeyringTransport } from "./sync.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreatedKeyring extends KeyringCredentials {
  /** The keyring link (KR-16): a password, to show once. */
  link: string;
}

/** Draws `S` and `K_t`, registers the verifier of `S` (KR-5). */
export async function createKeyring(
  apiBase: string,
  fetchFn: Fetch = fetch,
): Promise<CreatedKeyring> {
  const { secret, key } = newKeyringSecrets();
  const response = await fetchFn(`${apiBase}/keyrings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      v: PROTOCOL_VERSION,
      verifier: bytesToBase64Url(await keyringVerifier(secret)),
    }),
  });
  if (!response.ok)
    throw new Error(`creating a keyring failed (${response.status})`);
  const { keyring_id: keyringId } = (await response.json()) as {
    keyring_id: unknown;
  };
  if (typeof keyringId !== "string" || !/^[0-9a-f]{32}$/.test(keyringId)) {
    throw new Error("the server gave no keyring id");
  }
  const credentials = { keyringId, secret, key };
  return { ...credentials, link: formatKeyringLink(credentials) };
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

/** A server's keyring, by its id and `S`. */
export function httpKeyringTransport(
  apiBase: string,
  credentials: KeyringCredentials,
  fetchFn: Fetch = fetch,
): KeyringTransport {
  const url = `${apiBase}/keyrings/${credentials.keyringId}`;
  const secret = bytesToBase64Url(credentials.secret);
  const unexpected = (response: Response) =>
    new Error(`unexpected answer of the keyring server (${response.status})`);
  return {
    async read() {
      const response = await fetchFn(url, {
        headers: { "Keyring-Secret": secret },
      });
      if (response.status === 404) return "missing";
      if (response.status !== 200) throw unexpected(response);
      const v = version(response);
      return { version: v, blob: new Uint8Array(await response.arrayBuffer()) };
    },
    async write(expected, blob) {
      const response = await fetchFn(url, {
        method: "PUT",
        headers: {
          "Keyring-Secret": secret,
          "If-Match": `"${expected}"`,
          "Content-Type": "application/octet-stream",
        },
        body: blob as BodyInit,
      });
      if (response.status === 404) return "missing";
      if (response.status === 204) return { written: version(response) };
      if (response.status === 412) return { stale: version(response) };
      throw unexpected(response);
    },
  };
}

/** Deletes a keyring (KR-10): `missing` if it is gone already (KR-29). */
export async function deleteKeyring(
  apiBase: string,
  credentials: KeyringCredentials,
  fetchFn: Fetch = fetch,
): Promise<"deleted" | "missing"> {
  const response = await fetchFn(
    `${apiBase}/keyrings/${credentials.keyringId}`,
    {
      method: "DELETE",
      headers: { "Keyring-Secret": bytesToBase64Url(credentials.secret) },
    },
  );
  if (response.status === 204) return "deleted";
  if (response.status === 404) return "missing";
  throw new Error(`deleting a keyring failed (${response.status})`);
}

/** Leaves a deposit for another device (KR-31): its id, `missing` if the
 * keyring is gone, `too-many` if it has as many deposits as it may. */
export async function depositPairing(
  apiBase: string,
  credentials: KeyringCredentials,
  deposit: Uint8Array,
  fetchFn: Fetch = fetch,
): Promise<{ pairingId: string } | "missing" | "too-many"> {
  const response = await fetchFn(
    `${apiBase}/keyrings/${credentials.keyringId}/pairings`,
    {
      method: "POST",
      headers: {
        "Keyring-Secret": bytesToBase64Url(credentials.secret),
        "Content-Type": "application/octet-stream",
      },
      body: deposit as BodyInit,
    },
  );
  if (response.status === 404) return "missing";
  if (response.status === 429) return "too-many";
  if (response.status !== 200)
    throw new Error(`a deposit failed (${response.status})`);
  const { pairing_id: pairingId } = (await response.json()) as {
    pairing_id: unknown;
  };
  if (typeof pairingId !== "string" || !/^[0-9a-f]{32}$/.test(pairingId)) {
    throw new Error("the server gave no pairing id");
  }
  return { pairingId };
}

/** Takes a deposit (KR-32): its bytes, or `missing` — unknown, already
 * taken, or expired. */
export async function takePairing(
  apiBase: string,
  pairingId: string,
  fetchFn: Fetch = fetch,
): Promise<Uint8Array | "missing"> {
  const response = await fetchFn(`${apiBase}/pairings/${pairingId}/take`, {
    method: "POST",
  });
  if (response.status === 404) return "missing";
  if (response.status !== 200)
    throw new Error(`taking a deposit failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
