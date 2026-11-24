/** Signing and verifying an object (docs/protocol/06-identity.md, §6.4,
 * §6.6): `sig` is a short fingerprint and a signature (ID-7); the keys a
 * document knows are in its `identities` map (ID-8), checked on reading.
 * The message is built by the caller (`messages.ts`), for the signer it
 * names: what is verified is what is displayed. */
import type { LoroDoc } from "loro-crdt";
import {
  type IdentityKey,
  fingerprintOf,
  isAcceptablePublicKey,
  publicKeyFingerprint,
  signBytes,
  verifyBytes,
} from "./keys.js";

const SHORT = 8;
const SIG_BYTES = SHORT + 64;
export const IDENTITIES = "identities";

/** A public key a document knows, with its fingerprint. */
export interface KnownKey {
  publicKey: Uint8Array;
  fingerprint: Uint8Array;
}

/** The signer's key, ready to sign: its fingerprint computed once. */
export interface Signer extends IdentityKey {
  fingerprint: Uint8Array;
}

export async function signerOf(key: IdentityKey): Promise<Signer> {
  return { ...key, fingerprint: await publicKeyFingerprint(key.publicKey) };
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** `sig` (ID-7) of the message `build` makes for the signer; throws if
 * it can't be built (ID-14): nothing unsignable is written. */
export async function sign(
  signer: Signer,
  build: (
    signer: Uint8Array,
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>,
): Promise<Uint8Array> {
  const message = await build(signer.fingerprint);
  if (!message) throw new Error("this object can't be signed (ID-14)");
  const signature = await signBytes(signer.privateKey, message);
  const sig = new Uint8Array(SIG_BYTES);
  sig.set(signer.fingerprint.slice(0, SHORT), 0);
  sig.set(signature, SHORT);
  return sig;
}

/** The key that signed, if the object is signed (ID-15): `sig` well
 * formed, a known key of its short fingerprint, the message built for
 * it, and a valid signature. `undefined`: unverified (ID-16). */
export async function verify(
  sig: unknown,
  known: readonly KnownKey[],
  build: (
    signer: Uint8Array,
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>,
): Promise<KnownKey | undefined> {
  if (!(sig instanceof Uint8Array) || sig.length !== SIG_BYTES) {
    return undefined;
  }
  const short = sig.slice(0, SHORT);
  const signature = sig.slice(SHORT);
  for (const key of known) {
    if (!sameBytes(key.fingerprint.slice(0, SHORT), short)) continue;
    const message = await build(key.fingerprint);
    if (!message) return undefined;
    if (await verifyBytes(key.publicKey, signature, message)) return key;
  }
  return undefined;
}

/** A key as a presence state carries it (ID-11), or `undefined`. */
export function knownKey(publicKey: unknown): KnownKey | undefined {
  if (!(publicKey instanceof Uint8Array) || !isAcceptablePublicKey(publicKey)) {
    return undefined;
  }
  return { publicKey, fingerprint: fingerprintOf(publicKey) };
}

/** The well-formed entries of `identities` (ID-8): 32 bytes, an
 * acceptable key, under its own fingerprint. */
export function readIdentities(annotationsDoc: LoroDoc): KnownKey[] {
  const keys: KnownKey[] = [];
  for (const [name, value] of annotationsDoc.getMap(IDENTITIES).entries()) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const key = knownKey(value);
    if (key && toHex(key.fingerprint) === name) keys.push(key);
  }
  return keys;
}

/** Writes the signer's key in `identities` if the document doesn't hold
 * it (ID-8), without committing: in the commit of the first object it
 * signs (ID-12). `true` if written. */
export function addIdentity(
  annotationsDoc: LoroDoc,
  signer: Pick<Signer, "publicKey" | "fingerprint">,
): boolean {
  const table = annotationsDoc.getMap(IDENTITIES);
  const name = toHex(signer.fingerprint);
  const held = table.get(name);
  if (held instanceof Uint8Array && sameBytes(held, signer.publicKey)) {
    return false;
  }
  table.set(name, signer.publicKey);
  return true;
}
