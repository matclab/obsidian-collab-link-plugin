/** A notification encrypted for one subscription
 * (docs/protocol/02-links-and-encryption.md, K-20): RFC 8291, `aes128gcm`
 * (RFC 8188), one record padded to a fixed length — never with the
 * content key. WebCrypto only. */

/** The record's plaintext: the message, its delimiter, then zeros. */
export const RECORD_BYTES = 2048;
const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const POINT_BYTES = 65;

/** A message too long for one record (K-20): not sent. */
export class NotificationTooLong extends Error {
  constructor(readonly bytes: number) {
    super(`a notification of ${bytes} bytes doesn't fit its record`);
  }
}

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The sender's key pair: drawn for this payload alone, or, for the
 * vectors, the one of a given private key. */
async function senderKeys(
  given?: Uint8Array,
): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  if (!given) {
    const pair = await crypto.subtle.generateKey(algorithm, true, [
      "deriveBits",
    ]);
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    return { privateKey: pair.privateKey, publicKey };
  }
  // WebCrypto imports a raw private scalar as a JWK only, which wants its
  // point: derived by importing it without one is refused, so the vectors
  // go through PKCS#8 (RFC 5915 inside RFC 5208), which may omit it.
  const pkcs8 = concat(
    Uint8Array.of(
      0x30,
      0x41,
      0x02,
      0x01,
      0x00,
      0x30,
      0x13,
      0x06,
      0x07,
      0x2a,
      0x86,
      0x48,
      0xce,
      0x3d,
      0x02,
      0x01,
      0x06,
      0x08,
      0x2a,
      0x86,
      0x48,
      0xce,
      0x3d,
      0x03,
      0x01,
      0x07,
      0x04,
      0x27,
      0x30,
      0x25,
      0x02,
      0x01,
      0x01,
      0x04,
      0x20,
    ),
    given,
  );
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    algorithm,
    true,
    ["deriveBits"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const fromJwk = (text: string | undefined) =>
    Uint8Array.from(
      atob((text ?? "").replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
  return {
    privateKey,
    publicKey: concat(Uint8Array.of(4), fromJwk(jwk.x), fromJwk(jwk.y)),
  };
}

/** For the vectors only: the sender's private key, the salt, and the
 * record's length (`null`: unpadded, as RFC 8291's example). */
export interface FixedDraws {
  ephemeral?: Uint8Array;
  salt?: Uint8Array;
  record?: number | null;
}

/** The payload of `message` for the subscription of `p256dh` and `auth`
 * (K-20): throws `NotificationTooLong` beyond one record, or WebCrypto's
 * error for a `p256dh` that isn't a point. */
export async function encryptNotification(
  message: string,
  subscription: { p256dh: Uint8Array; auth: Uint8Array },
  draws: FixedDraws = {},
): Promise<Uint8Array> {
  const plaintext = encoder.encode(message);
  const record = draws.record === undefined ? RECORD_BYTES : draws.record;
  if (record !== null && plaintext.length + 1 > record) {
    throw new NotificationTooLong(plaintext.length);
  }
  const { p256dh, auth } = subscription;
  const sender = await senderKeys(draws.ephemeral);
  const receiver = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64Url(p256dh.slice(1, 33)),
      y: base64Url(p256dh.slice(33, POINT_BYTES)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiver },
      sender.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    auth,
    shared,
    concat(encoder.encode("WebPush: info\0"), p256dh, sender.publicKey),
    32,
  );
  const salt = draws.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );
  const padded = new Uint8Array(record ?? plaintext.length + 1);
  padded.set(plaintext, 0);
  padded[plaintext.length] = 2;
  const key = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      padded as BufferSource,
    ),
  );
  const header = new Uint8Array(SALT_BYTES + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, RECORD_SIZE);
  header[SALT_BYTES + 4] = POINT_BYTES;
  return concat(header, sender.publicKey, body);
}
