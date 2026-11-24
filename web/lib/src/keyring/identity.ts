/** The identity key a keyring holds (docs/protocol/05-keyring.md, KR-38,
 * decision 8): the same on every device of the person. One
 * value — PKCS#8 then the public key — so that two devices that each
 * write one keep one of them whole. Pure. */
import type { LoroDoc } from "loro-crdt";
import { isAcceptablePublicKey } from "../identity/keys.js";

const ROOT = "identity";
const ENTRY = "ed25519";
/** PKCS#8 of an Ed25519 key: this prefix, then the 32-byte seed. */
const PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
];
const PKCS8_BYTES = 48;

export interface KeyringIdentity {
  pkcs8: Uint8Array;
  publicKey: Uint8Array;
}

/** The key, or `null`: none, or a value of another form (KR-38). Whether
 * the public key is the private key's is for the one who imports it. */
export function keyringIdentity(doc: LoroDoc): KeyringIdentity | null {
  const value = doc.getMap(ROOT).get(ENTRY);
  if (!(value instanceof Uint8Array) || value.length !== PKCS8_BYTES + 32) {
    return null;
  }
  const pkcs8 = value.slice(0, PKCS8_BYTES);
  const publicKey = value.slice(PKCS8_BYTES);
  if (
    PKCS8_PREFIX.some((byte, i) => pkcs8[i] !== byte) ||
    !isAcceptablePublicKey(publicKey)
  ) {
    return null;
  }
  return { pkcs8, publicKey };
}

/** Writes the key, and commits. */
export function setKeyringIdentity(
  doc: LoroDoc,
  pkcs8: Uint8Array,
  publicKey: Uint8Array,
): void {
  const value = new Uint8Array(PKCS8_BYTES + 32);
  value.set(pkcs8, 0);
  value.set(publicKey, PKCS8_BYTES);
  doc.getMap(ROOT).set(ENTRY, value);
  doc.commit();
}
