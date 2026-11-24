// Keys, fingerprints and Ed25519 (docs/protocol/06-identity.md, ID-4 –
// ID-6, ID-15): RFC 8032's first vector; the keys and signatures the
// specification refuses whatever a library would say — small order,
// non-canonical encodings, a non-reduced S.
import { describe, expect, test } from "vitest";
import {
  formatShortFingerprint,
  generateIdentityKey,
  isAcceptablePublicKey,
  publicKeyFingerprint,
  signBytes,
  verifyBytes,
} from "./keys.js";

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// RFC 8032, §7.1, test 1: the empty message.
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const SIGNATURE =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function addToS(signature: Uint8Array, add: bigint): Uint8Array {
  const out = signature.slice();
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(out[i] as number);
  s += add;
  for (let i = 32; i < 64; i++) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

describe("identity keys", () => {
  test("ID-5: a fingerprint is the SHA-256 of the public key; shown short, in groups", async () => {
    const fingerprint = await publicKeyFingerprint(bytes(PUBLIC));
    expect(hex(fingerprint)).toBe(
      "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9",
    );
    expect(formatShortFingerprint(fingerprint)).toBe("21fe 31df a154 a261");
  });

  test("RFC 8032, test 1: verifies; one bit changed doesn't", async () => {
    const pk = bytes(PUBLIC);
    const empty = new Uint8Array(0);
    expect(await verifyBytes(pk, bytes(SIGNATURE), empty)).toBe(true);
    const altered = bytes(SIGNATURE);
    altered[10] = (altered[10] as number) ^ 1;
    expect(await verifyBytes(pk, altered, empty)).toBe(false);
    expect(await verifyBytes(pk, bytes(SIGNATURE), new Uint8Array([0]))).toBe(
      false,
    );
    // ID-15: S not below L is invalid, though the equation holds.
    expect(await verifyBytes(pk, addToS(bytes(SIGNATURE), L), empty)).toBe(
      false,
    );
    // Malformed: never an exception.
    expect(await verifyBytes(pk, bytes(SIGNATURE).slice(1), empty)).toBe(false);
    expect(await verifyBytes(pk.slice(1), bytes(SIGNATURE), empty)).toBe(false);
  });

  test("ID-6: small-order and non-canonical keys are not acceptable", async () => {
    const refused = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000080",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      // y ≥ p: non-canonical.
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const key of refused) {
      expect(isAcceptablePublicKey(bytes(key)), key).toBe(false);
      // Whatever the signature: the identity point "verifies" (R = 0,
      // S = 0) in the bare equation.
      const zero = new Uint8Array(64);
      zero[0] = 1;
      expect(await verifyBytes(bytes(key), zero, new Uint8Array()), key).toBe(
        false,
      );
    }
    expect(isAcceptablePublicKey(bytes(PUBLIC))).toBe(true);
    expect(isAcceptablePublicKey(new Uint8Array(31))).toBe(false);
  });

  test("a key drawn signs, and its signature verifies under its public key only", async () => {
    const key = await generateIdentityKey();
    const other = await generateIdentityKey();
    expect(isAcceptablePublicKey(key.publicKey)).toBe(true);
    const message = new TextEncoder().encode("hello");
    const signature = await signBytes(key.privateKey, message);
    expect(signature).toHaveLength(64);
    expect(await verifyBytes(key.publicKey, signature, message)).toBe(true);
    expect(await verifyBytes(other.publicKey, signature, message)).toBe(false);
  });
});
