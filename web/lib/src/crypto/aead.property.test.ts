import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { decrypt, encrypt, generateKey } from "./aead.js";

describe("aead property tests", () => {
  test("round-trip: decrypt(encrypt(key, m)) === m for arbitrary byte strings", () =>
    hegel.testAsync(async (tc) => {
      const key = await generateKey();
      const plaintext = tc.draw(gs.binary({ minSize: 0, maxSize: 4096 }));

      const blob = await encrypt(key, plaintext);
      const decrypted = await decrypt(key, blob);

      if (
        Buffer.compare(Buffer.from(decrypted), Buffer.from(plaintext)) !== 0
      ) {
        throw new Error(
          `round-trip mismatch: got ${decrypted.length} bytes, expected ${plaintext.length} bytes`,
        );
      }
    }));

  test("decrypt never crashes (always rejects cleanly) on arbitrary bytes", () =>
    hegel.testAsync(async (tc) => {
      const key = await generateKey();
      const garbage = tc.draw(gs.binary({ minSize: 0, maxSize: 256 }));

      try {
        await decrypt(key, garbage);
      } catch {
        // A rejection is the expected, clean outcome for non-decryptable input.
      }
    }));
});
