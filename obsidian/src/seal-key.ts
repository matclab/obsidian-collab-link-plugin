import { base64UrlToBytes, bytesToBase64Url } from "../../web/lib/src/index.js";
import type { KeyringLock } from "../../web/src/embed.js";
import { type SecretStore, secretId } from "./link-store.js";

/** The key of the device that seals the keyring's secrets in Obsidian's
 * IndexedDB (docs/phase-18-trousseau-identite.md, M2): 32 random bytes in
 * `app.secretStorage`, encrypted by the system's keyring where there is one.
 * Read, or drawn and kept, under the lock: two windows of the vault starting
 * together keep one. */
export function deviceSealKey(
  secrets: SecretStore,
  lock: KeyringLock,
): Promise<Uint8Array> {
  const id = secretId("seal", "keyring");
  return lock.exclusive(`collab-link:${id}`, async () => {
    const kept = secrets.getSecret(id);
    if (kept) {
      try {
        const key = base64UrlToBytes(kept);
        if (key.length === 32 && bytesToBase64Url(key) === kept) return key;
      } catch {}
    }
    const key = crypto.getRandomValues(new Uint8Array(32));
    secrets.setSecret(id, bytesToBase64Url(key));
    return key;
  });
}
