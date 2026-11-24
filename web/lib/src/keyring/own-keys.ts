/** The other keys a person signed with (docs/protocol/05-keyring.md,
 * KR-46; ADR-0050 §3): a device's own key from before it used the keyring,
 * the keyring's key that a merge replaced. One entry per key, so that two
 * devices adding theirs keep both. Pure. */
import type { LoroDoc } from "loro-crdt";
import { base64UrlToBytes, bytesToBase64Url } from "../crypto/role-secrets.js";
import { isAcceptablePublicKey } from "../identity/keys.js";

const ROOT = "keys";

/** The public key an entry names, or `null` (KR-46: 32 acceptable bytes,
 * under an integer). */
function readKey(name: string, value: unknown): Uint8Array | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  try {
    const key = base64UrlToBytes(name);
    return key.length === 32 && isAcceptablePublicKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** The keys listed, each once, in the order of their entries. */
export function ownKeys(doc: LoroDoc): Uint8Array[] {
  const seen = new Set<string>();
  const keys: Uint8Array[] = [];
  for (const [name, value] of doc.getMap(ROOT).entries()) {
    const key = readKey(name, value);
    if (!key) continue;
    const canonical = bytesToBase64Url(key);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    keys.push(key);
  }
  return keys;
}

/** Adds `publicKey`, noted at `at` (Unix milliseconds), and commits;
 * `false`, writing nothing, if it is listed already or isn't acceptable. */
export function addOwnKey(
  doc: LoroDoc,
  publicKey: Uint8Array,
  at: number,
): boolean {
  if (publicKey.length !== 32 || !isAcceptablePublicKey(publicKey)) {
    return false;
  }
  const name = bytesToBase64Url(publicKey);
  if (readKey(name, doc.getMap(ROOT).get(name))) return false;
  doc.getMap(ROOT).set(name, at);
  doc.commit();
  return true;
}
