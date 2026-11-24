/** Identity keys (docs/protocol/06-identity.md, §6.3): Ed25519 by WebCrypto,
 * fingerprints, and the rules that make every client reach the same
 * verdict — keys of small order or non-canonical refused (ID-6), `S`
 * below the group order (ID-15) — checked here before WebCrypto, whose
 * engines differ on them. Bytes in, bytes out. */
import { sha256 } from "../annotations/sha256.js";

/** A key pair: the private key as WebCrypto holds it (not extractable,
 * unless drawn for a keyring), the public key raw (ID-4). */
export interface IdentityKey {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** Points of small order, their sign bit cleared (ID-6). */
const SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A little-endian integer. */
function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i] as number);
  }
  return n;
}

/** ID-6. */
export function isAcceptablePublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false;
  const cleared = publicKey.slice();
  cleared[31] = (cleared[31] as number) & 0x7f;
  if (littleEndian(cleared) >= P) return false;
  return !SMALL_ORDER.includes(toHex(cleared));
}

/** ID-5, synchronous: what an index computes for every key it reads. */
export function fingerprintOf(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}

/** ID-5. */
export async function publicKeyFingerprint(
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", publicKey as BufferSource),
  );
}

/** ID-5: `3fa1 9c02 77de 01b4`. */
export function formatShortFingerprint(fingerprint: Uint8Array): string {
  return (toHex(fingerprint.slice(0, 8)).match(/.{4}/g) ?? []).join(" ");
}

/** A new key pair; extractable only to be kept in a keyring (decision 8):
 * a device's own key never leaves WebCrypto. */
export async function generateIdentityKey(
  options: { extractable?: boolean } = {},
): Promise<IdentityKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    options.extractable ?? false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}

/** The private key in PKCS#8, for a keyring; throws on a key drawn not
 * extractable. */
export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
}

/** A key pair from its PKCS#8 private key and raw public key (a
 * keyring's), not extractable once imported. */
export async function importIdentityKey(
  pkcs8: Uint8Array,
  publicKey: Uint8Array,
): Promise<IdentityKey> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { privateKey, publicKey: publicKey.slice() };
}

/** The 64-byte Ed25519 signature of `message` (RFC 8032, §5.1.6). */
export async function signBytes(
  privateKey: CryptoKey,
  message: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      message as BufferSource,
    ),
  );
}

/** ID-15: an acceptable key, a signature of 64 bytes whose `S` is below
 * `L`, and RFC 8032's check. Never throws: malformed is `false`. */
export async function verifyBytes(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (!isAcceptablePublicKey(publicKey) || signature.length !== 64) {
    return false;
  }
  if (littleEndian(signature.slice(32)) >= L) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature as BufferSource,
      message as BufferSource,
    );
  } catch {
    return false;
  }
}
