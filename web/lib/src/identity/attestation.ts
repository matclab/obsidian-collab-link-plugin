/** Attested names (docs/protocol/06-identity.md, §6.10): the attestations
 * a document carries (ID-37), the revocation list a server serves
 * (ID-40), and whether an attestation covers an object's date (ID-39).
 * What is read here was signed by a gateway and carried by others: it is
 * read strictly (ID-36), against the attestation keys this deployment
 * configured, and never throws. */
import type { LoroDoc } from "loro-crdt";
import { sha256 } from "../annotations/sha256.js";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import { type Canonical, decodeCanonical } from "./cbor.js";
import { isAcceptablePublicKey, verifyBytes } from "./keys.js";

/** The root map of the annotations doc that holds them (ID-37). */
export const ATTESTATIONS = "attestations";

/** An attestation read from a valid entry (ID-27, ID-37). */
export interface Attestation {
  /** Its entry's key: the envelope's SHA-256, in hexadecimal. */
  id: string;
  issuer: string;
  sub: string;
  name: string;
  email?: string;
  /** The attested public key. */
  key: Uint8Array;
  /** Unix seconds, by the gateway's clock. */
  issuedAt: number;
  expiresAt: number;
}

/** A valid revocation list (ID-40). */
export interface RevocationList {
  issuedAt: number;
  /** Fingerprint in hexadecimal → Unix second of its revocation. */
  revoked: ReadonlyMap<string, number>;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

type Fields = Record<string, Canonical>;

function isMap(value: Canonical | undefined): value is Fields {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  );
}

/** Exactly these keys, each of them. */
function hasExactly(map: Fields, required: string[], optional: string[] = []) {
  const keys = Object.keys(map);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

const isCount = (value: Canonical | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isBytes = (value: Canonical | undefined, length: number) =>
  value instanceof Uint8Array && value.length === length;

/** ID-26, ID-36: the message of an envelope of a configured key whose
 * signature verifies, decoded; `undefined` otherwise. */
async function readEnvelope(
  bytes: Uint8Array,
  configured: ReadonlySet<string>,
): Promise<Fields | undefined> {
  const envelope = decodeCanonical(bytes);
  if (!isMap(envelope) || !hasExactly(envelope, ["key", "msg", "sig"])) {
    return undefined;
  }
  const { key, msg, sig } = envelope;
  if (!isBytes(key, 32) || !isBytes(sig, 64) || !(msg instanceof Uint8Array)) {
    return undefined;
  }
  const publicKey = key as Uint8Array;
  if (!configured.has(toHex(sha256(publicKey)))) return undefined;
  if (!(await verifyBytes(publicKey, sig as Uint8Array, msg))) return undefined;
  const message = decodeCanonical(msg);
  return isMap(message) ? message : undefined;
}

/** ID-37: the attestation of an entry of `attestations`, if valid. */
export async function readAttestationEntry(
  entryKey: string,
  value: unknown,
  configured: ReadonlySet<string>,
): Promise<Attestation | undefined> {
  if (!(value instanceof Uint8Array) || configured.size === 0) return undefined;
  if (entryKey !== toHex(sha256(value))) return undefined;
  const m = await readEnvelope(value, configured);
  if (
    !m ||
    !hasExactly(
      m,
      ["ctx", "issuer", "sub", "name", "key", "issuedAt", "expiresAt"],
      ["email"],
    )
  ) {
    return undefined;
  }
  const { ctx, issuer, sub, name, email, key, issuedAt, expiresAt } = m;
  const well =
    ctx === "oc-attestation/v1" &&
    typeof issuer === "string" &&
    typeof sub === "string" &&
    typeof name === "string" &&
    (email === undefined || typeof email === "string") &&
    isBytes(key, 32) &&
    isAcceptablePublicKey(key as Uint8Array) &&
    isCount(issuedAt) &&
    isCount(expiresAt) &&
    expiresAt > issuedAt;
  if (!well) return undefined;
  return {
    id: entryKey,
    issuer: issuer as string,
    sub: sub as string,
    name: name as string,
    ...(email === undefined ? {} : { email: email as string }),
    key: key as Uint8Array,
    issuedAt: issuedAt as number,
    expiresAt: expiresAt as number,
  };
}

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** ID-40: the list a body of `GET /revocations` carries, if valid. Its
 * `issuedAt` is the signed one, never the body's. */
export async function readRevocationBody(
  text: string,
  configured: ReadonlySet<string>,
): Promise<RevocationList | undefined> {
  let list: Uint8Array;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return undefined;
    }
    const encoded = (body as Record<string, unknown>).list;
    if (typeof encoded !== "string") return undefined;
    list = base64UrlToBytes(encoded);
    // Written as its encoder writes it, nothing else (ID-33).
    if (bytesToBase64Url(list) !== encoded) return undefined;
  } catch {
    return undefined;
  }
  const m = await readEnvelope(list, configured);
  if (!m || !hasExactly(m, ["ctx", "issuedAt", "revoked"])) return undefined;
  const { ctx, issuedAt, revoked } = m;
  if (ctx !== "oc-revocations/v1" || !isCount(issuedAt) || !isMap(revoked)) {
    return undefined;
  }
  const entries = Object.entries(revoked);
  if (!entries.every(([f, at]) => FINGERPRINT.test(f) && isCount(at))) {
    return undefined;
  }
  return { issuedAt, revoked: new Map(entries as [string, number][]) };
}

/** ID-40: of two lists, the one to retain — never an older one. */
export function newerList(
  kept: RevocationList | undefined,
  read: RevocationList | undefined,
): RevocationList | undefined {
  if (!read) return kept;
  return !kept || read.issuedAt > kept.issuedAt ? read : kept;
}

/** When the list revoked `key`, in Unix seconds, if it did. */
export function revocationOf(
  list: RevocationList | undefined,
  key: Uint8Array,
): number | undefined {
  return list?.revoked.get(toHex(sha256(key)));
}

/** ID-39: whether `attestation` attests an object of its key dated `date`
 * (milliseconds), the key revoked at `revokedAt` (seconds) or never. */
export function attests(
  attestation: Attestation,
  date: number,
  revokedAt: number | undefined,
): boolean {
  return (
    attestation.issuedAt * 1000 <= date &&
    date < attestation.expiresAt * 1000 &&
    (revokedAt === undefined || date < revokedAt * 1000)
  );
}

/** ID-37, ID-38: puts an envelope under its digest, unless it is there
 * already — other bytes under that key are no attestation, and give way.
 * To commit with the object that relies on it. */
export function addAttestation(annotationsDoc: LoroDoc, envelope: Uint8Array) {
  const map = annotationsDoc.getMap(ATTESTATIONS);
  const id = toHex(sha256(envelope));
  const held = map.get(id);
  const same =
    held instanceof Uint8Array &&
    held.length === envelope.length &&
    held.every((byte, i) => byte === envelope[i]);
  if (!same) map.set(id, envelope);
}
