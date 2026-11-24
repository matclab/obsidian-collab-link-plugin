// ADR-0040, point 75: Ed25519 detected, not assumed.
import { describe, expect, test } from "vitest";
import { ed25519Supported } from "./ed25519.js";

describe("Ed25519 in this Obsidian", () => {
  test("found where WebCrypto draws a key", async () => {
    expect(await ed25519Supported()).toBe(true);
  });

  test("missing where it refuses the algorithm, or has no WebCrypto", async () => {
    const refusing = {
      generateKey: async () => {
        throw new DOMException("Unrecognized name", "NotSupportedError");
      },
    } as unknown as SubtleCrypto;
    expect(await ed25519Supported(refusing)).toBe(false);
    expect(
      await ed25519Supported(null as unknown as SubtleCrypto | undefined),
    ).toBe(false);
  });
});
