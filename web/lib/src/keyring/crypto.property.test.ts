// Round trips of the keyring's link and blob (docs/protocol/05-keyring.md,
// KR-16, KR-18): what is formatted reads back, what is encrypted decrypts,
// and arbitrary bytes under the key never decrypt silently into anything.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  decryptKeyring,
  encryptKeyring,
  formatKeyringLink,
  newKeyringSecrets,
  parseKeyringLink,
} from "./crypto.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the keyring's link and blob", () => {
  test("KR-16: a formatted link reads back as itself", () =>
    hegel.test((tc) => {
      const keyringId = hex(tc.draw(gs.binary({ minSize: 16, maxSize: 16 })));
      const secret = tc.draw(gs.binary({ minSize: 32, maxSize: 32 }));
      const key = tc.draw(gs.binary({ minSize: 32, maxSize: 32 }));
      const parsed = parseKeyringLink(
        formatKeyringLink({ keyringId, secret, key }),
      );
      expect([parsed.keyringId, hex(parsed.secret), hex(parsed.key)]).toEqual([
        keyringId,
        hex(secret),
        hex(key),
      ]);
    }));

  test("KR-18: a blob decrypts to its plaintext, under its key only", () =>
    hegel.testAsync(async (tc) => {
      const { key } = newKeyringSecrets();
      const plaintext = tc.draw(gs.binary({ minSize: 0, maxSize: 2048 }));
      const blob = await encryptKeyring(key, plaintext);
      expect(hex(await decryptKeyring(key, blob))).toBe(hex(plaintext));
      await expect(
        decryptKeyring(newKeyringSecrets().key, blob),
      ).rejects.toThrow();
    }));

  test("KR-19: arbitrary bytes are refused, never read", () =>
    hegel.testAsync(async (tc) => {
      const { key } = newKeyringSecrets();
      const bytes = tc.draw(gs.binary({ minSize: 0, maxSize: 128 }));
      await expect(decryptKeyring(key, bytes)).rejects.toThrow();
    }));
});
