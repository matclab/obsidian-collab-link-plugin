// A receiver of RFC 8291, written from the RFC alone (§3.3, §3.4, and RFC
// 8188 §2): what a browser does with a push message. Tests only, never
// imported by the code it checks. Node's `crypto`, not WebCrypto, so that
// a mistake shared by both sides of a round trip can't hide.
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";

const utf8 = (text: string) => Buffer.from(text, "utf8");

/** The plaintext of `payload` (one record, padding and delimiter removed),
 * for the subscription of private key `uaPrivate` (32 bytes) and `auth`. */
export function decryptPush(
  payload: Uint8Array,
  uaPrivate: Uint8Array,
  auth: Uint8Array,
): { plaintext: Uint8Array; recordSize: number; recordLength: number } {
  const bytes = Buffer.from(payload);
  const salt = bytes.subarray(0, 16);
  const recordSize = bytes.readUInt32BE(16);
  const idLength = bytes[20] ?? 0;
  const asPublic = bytes.subarray(21, 21 + idLength);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(Buffer.from(uaPrivate));
  const uaPublic = ua.getPublicKey();
  const secret = ua.computeSecret(asPublic);
  const hkdf = (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    Buffer.from(hkdfSync("sha256", ikm, s, info, n));
  const ikm = hkdf(
    auth,
    secret,
    Buffer.concat([utf8("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const body = bytes.subarray(21 + idLength);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const record = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 2) throw new Error("not the last record's delimiter");
  return {
    plaintext: new Uint8Array(record.subarray(0, end)),
    recordSize,
    recordLength: record.length,
  };
}

/** A P-256 key pair from Node, raw: for a subscription in a test. */
export function p256Pair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: new Uint8Array(ecdh.getPrivateKey()),
    publicKey: new Uint8Array(ecdh.getPublicKey()),
  };
}
