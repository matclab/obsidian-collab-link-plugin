// The key of the device that seals the keyring's secrets in IndexedDB
// (docs/phase-18-trousseau-identite.md, analysis 18m, M2; interleaving 6):
// drawn once, kept in `app.secretStorage`, the same for every window of
// the vault — two windows starting together never keep two.
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../../web/lib/src/index.js";
import { secretId } from "./link-store.js";
import { deviceSealKey } from "./seal-key.js";
import { fakeSecrets } from "./test-support/secrets.js";

/** One holder at a time per name, in arrival order (`navigator.locks`). */
function memoryLock() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    exclusive<T>(name: string, run: () => Promise<T>): Promise<T> {
      const result = (tails.get(name) ?? Promise.resolve()).then(run, run);
      tails.set(
        name,
        result.catch(() => {}),
      );
      return result;
    },
  };
}

const ID = secretId("seal", "keyring");

describe("the key that seals the keyring's secrets", () => {
  test("drawn once, kept in the secret storage, read back", async () => {
    const secrets = fakeSecrets();
    const lock = memoryLock();
    const key = await deviceSealKey(secrets, lock);
    expect(key).toHaveLength(32);
    expect(secrets.getSecret(ID)).toBe(bytesToBase64Url(key));
    expect(await deviceSealKey(secrets, lock)).toEqual(key);
  });

  test("two windows starting together keep one key", async () => {
    const secrets = fakeSecrets();
    const lock = memoryLock();
    const [a, b] = await Promise.all([
      deviceSealKey(secrets, lock),
      deviceSealKey(secrets, lock),
    ]);
    expect(a).toEqual(b);
  });

  test("a value that isn't a key is replaced: what it sealed was lost", async () => {
    for (const bad of ["", "not a key", bytesToBase64Url(new Uint8Array(31))]) {
      const secrets = fakeSecrets();
      secrets.setSecret(ID, bad);
      const key = await deviceSealKey(secrets, memoryLock());
      expect(key).toHaveLength(32);
      expect(secrets.getSecret(ID)).toBe(bytesToBase64Url(key));
    }
  });
});
