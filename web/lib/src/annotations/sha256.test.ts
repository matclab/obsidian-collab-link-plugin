import { createHash } from "node:crypto";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { sha256 } from "./sha256.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const reference = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("sha256", () => {
  test("matches the FIPS 180-4 test vectors", () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    expect(hex(sha256(utf8("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      hex(
        sha256(
          utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  test("equals node:crypto on arbitrary input, around every block boundary", () =>
    hegel.test((tc) => {
      const bytes = tc.draw(gs.binary({ maxSize: 300 }));
      const input = new Uint8Array(bytes);
      if (hex(sha256(input)) !== reference(input)) {
        throw new Error(`mismatch on ${hex(input)}`);
      }
    }));
});
