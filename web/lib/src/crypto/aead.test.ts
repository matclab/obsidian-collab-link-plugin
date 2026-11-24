import { describe, expect, test } from "vitest";
import {
  decrypt,
  encrypt,
  exportKeyToBase64Url,
  generateKey,
  importKeyFromBase64Url,
} from "./aead.js";

describe("aead", () => {
  test("decrypt(encrypt(key, m)) === m", async () => {
    const key = await generateKey();
    const plaintext = new TextEncoder().encode("hello world");

    const blob = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, blob);

    expect(decrypted).toEqual(plaintext);
  });

  test("decrypt rejects when the wrong key is used", async () => {
    const key = await generateKey();
    const wrongKey = await generateKey();
    const blob = await encrypt(key, new TextEncoder().encode("secret"));

    await expect(decrypt(wrongKey, blob)).rejects.toThrow();
  });

  test("decrypt rejects when the ciphertext/tag has been tampered with", async () => {
    const key = await generateKey();
    const blob = await encrypt(key, new TextEncoder().encode("secret"));
    const tampered = blob.slice();
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;

    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  test("round-trips an empty message", async () => {
    const key = await generateKey();
    const plaintext = new Uint8Array(0);

    const blob = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, blob);

    expect(decrypted).toEqual(plaintext);
  });

  test("decrypt rejects cleanly on a blob shorter than the nonce, without throwing a raw crypto internal error", async () => {
    const key = await generateKey();

    await expect(decrypt(key, new Uint8Array(3))).rejects.toThrow();
  });

  test("decrypt rejects cleanly on random garbage the size of a real blob", async () => {
    const key = await generateKey();
    const garbage = crypto.getRandomValues(new Uint8Array(12 + 16));

    await expect(decrypt(key, garbage)).rejects.toThrow();
  });

  test("a key exported to base64url and re-imported decrypts what the original key encrypted", async () => {
    const key = await generateKey();
    const plaintext = new TextEncoder().encode("shared via the URL fragment");
    const blob = await encrypt(key, plaintext);

    const exported = await exportKeyToBase64Url(key);
    const reimported = await importKeyFromBase64Url(exported);
    const decrypted = await decrypt(reimported, blob);

    expect(decrypted).toEqual(plaintext);
  });
});
