import { sha256 } from "../annotations/sha256.js";
/** The key of an account and its attestation, from a client (docs/
 * protocol/06-identity.md, ID-28 – ID-31): the key the gateway holds for
 * the account (`me`), its registration with the proof of its possession,
 * and an attestation of it — kept only if it is one of a configured key,
 * for the key asked (ID-37). Without state: the page keeps what it got. */
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  type Attestation,
  readAttestationEntry,
} from "../identity/attestation.js";
import { encodeCanonical } from "../identity/cbor.js";
import { signBytes } from "../identity/keys.js";
import type { Signer } from "../identity/signature.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function unexpected(response: Response): never {
  throw new Error(`the gateway answered ${response.status}`);
}

/** 32 bytes in base64url, exactly as written. */
function key32(text: unknown): Uint8Array {
  if (typeof text !== "string") throw new Error("not a key");
  const bytes = base64UrlToBytes(text);
  if (bytes.length !== 32 || bytesToBase64Url(bytes) !== text) {
    throw new Error("not a key");
  }
  return bytes;
}

/** ID-28: the account's registered key, `null` if none; `signed-out` for
 * a token no longer valid. Rejects on anything else. */
export async function accountKey(
  gateway: string,
  token: string,
  fetchFn: Fetch = fetch,
): Promise<Uint8Array | null | "signed-out"> {
  const response = await fetchFn(new URL("/accounts/me", gateway).href, {
    headers: bearer(token),
  });
  if (response.status === 401) return "signed-out";
  if (response.status !== 200) unexpected(response);
  const me: unknown = await response.json();
  if (typeof me !== "object" || me === null || Array.isArray(me)) {
    throw new Error("not an account");
  }
  const { key } = me as Record<string, unknown>;
  return key === null ? null : key32(key);
}

/** ID-29: registers `signer`'s key for the account, with its proof. */
export async function registerKey(
  gateway: string,
  token: string,
  account: { issuer: string; sub: string },
  signer: Pick<Signer, "privateKey" | "publicKey">,
  fetchFn: Fetch = fetch,
): Promise<"registered" | "signed-out" | "not-recent" | "refused"> {
  const message = encodeCanonical({
    ctx: "oc-key-proof/v1",
    issuer: account.issuer,
    sub: account.sub,
    key: signer.publicKey,
  });
  const proof = await signBytes(signer.privateKey, message);
  const response = await fetchFn(new URL("/accounts/key", gateway).href, {
    method: "PUT",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      key: bytesToBase64Url(signer.publicKey),
      proof: bytesToBase64Url(proof),
    }),
  });
  switch (response.status) {
    case 204:
      return "registered";
    case 401:
      return "signed-out";
    case 403:
      return "not-recent";
    // A key revoked, or another account's (ID-29).
    case 409:
      return "refused";
    default:
      unexpected(response);
  }
}

/** ID-30: an attestation of `key`, its envelope and what it says; `not-
 * the-key` when the account's key is none or another (case 7). Rejects
 * on an attestation that isn't one of `configured` keys, or not of `key`:
 * never kept. */
export async function requestAttestation(
  gateway: string,
  token: string,
  key: Uint8Array,
  configured: ReadonlySet<string>,
  fetchFn: Fetch = fetch,
): Promise<
  | { envelope: Uint8Array; attestation: Attestation }
  | "not-the-key"
  | "signed-out"
> {
  const response = await fetchFn(
    new URL("/accounts/attestation", gateway).href,
    {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ key: bytesToBase64Url(key) }),
    },
  );
  if (response.status === 401) return "signed-out";
  if (response.status === 409) return "not-the-key";
  if (response.status !== 200) unexpected(response);
  const body: unknown = await response.json();
  const encoded =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).attestation
      : undefined;
  if (typeof encoded !== "string") throw new Error("not an attestation");
  const envelope = base64UrlToBytes(encoded);
  const attestation = await readAttestationEntry(
    toHex(sha256(envelope)),
    envelope,
    configured,
  );
  if (!attestation || toHex(attestation.key) !== toHex(key)) {
    throw new Error("not an attestation of this key by a configured gateway");
  }
  return { envelope, attestation };
}
