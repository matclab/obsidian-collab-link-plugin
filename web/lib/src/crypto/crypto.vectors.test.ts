// Links and encryption against the specification's vectors
// (docs/protocol/02-links-and-encryption.md, docs/protocol/vectors.json).
import { describe, expect, test } from "vitest";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import { decrypt, importKeyFromBase64Url } from "./aead.js";
import { parseLinkFragment } from "./link-fragment.js";
import { type Role, deriveRoleSecrets, verifier } from "./role-secrets.js";

const { keys } = vectors;

describe("links and encryption, as the vectors say", () => {
  test("K-7: the read and suggest secrets derive from the edit secret", async () => {
    const secrets = await deriveRoleSecrets(fromHex(keys.edit_secret));
    expect({
      read: toHex(secrets.read),
      suggest: toHex(secrets.suggest),
      edit: toHex(secrets.edit),
    }).toEqual(keys.role_secrets);
  });

  test.each(
    keys.verifiers as { role: Role; secret: string; verifier: string }[],
  )(
    "K-8: the verifier of a $role secret",
    async ({ role, secret, verifier: expected }) => {
      expect(toHex(await verifier(role, fromHex(secret)))).toBe(expected);
    },
  );

  test("K-10: blobs decrypt to their plaintext; altered or short ones don't", async () => {
    const key = await importKeyFromBase64Url(keys.content_key.base64url);
    for (const { blob, plaintext } of keys.blobs) {
      expect(toHex(await decrypt(key, fromHex(blob)))).toBe(plaintext);
    }
    for (const { blob } of keys.blobs_that_dont_decrypt) {
      await expect(decrypt(key, fromHex(blob))).rejects.toThrow();
    }
  });

  test("K-2: links are read, or refused", () => {
    for (const { fragment, key, role, secret } of keys.links.valid) {
      const link = parseLinkFragment(fragment);
      expect({
        key: link.key,
        role: link.role,
        secret: toHex(link.secret),
      }).toEqual({
        key,
        role,
        secret,
      });
    }
    for (const { why, fragment } of keys.links.invalid) {
      expect(() => parseLinkFragment(fragment), why).toThrow();
    }
  });
});
