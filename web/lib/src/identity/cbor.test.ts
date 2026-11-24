// The canonical encoding of signed messages (docs/protocol/06-identity.md,
// ID-1 – ID-3): deterministic CBOR of maps with text keys, texts, bytes,
// safe integers and booleans; by example, from RFC 8949's appendix A where
// it has them.
import { describe, expect, test } from "vitest";
import { encodeCanonical } from "./cbor.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the canonical encoding", () => {
  test("ID-1, ID-2: integers in their shortest form (RFC 8949, appendix A)", () => {
    const cases: [number, string][] = [
      [0, "00"],
      [23, "17"],
      [24, "1818"],
      [255, "18ff"],
      [256, "190100"],
      [65535, "19ffff"],
      [65536, "1a00010000"],
      [4294967295, "1affffffff"],
      [4294967296, "1b0000000100000000"],
      [Number.MAX_SAFE_INTEGER, "1b001fffffffffffff"],
      [-1, "20"],
      [-24, "37"],
      [-25, "3818"],
      [-1000, "3903e7"],
      [-Number.MAX_SAFE_INTEGER, "3b001ffffffffffffe"],
    ];
    for (const [value, expected] of cases) {
      expect(hex(encodeCanonical(value)), String(value)).toBe(expected);
    }
  });

  test("texts in UTF-8, bytes, booleans", () => {
    expect(hex(encodeCanonical(""))).toBe("60");
    expect(hex(encodeCanonical("a"))).toBe("6161");
    expect(hex(encodeCanonical("ü"))).toBe("62c3bc");
    expect(hex(encodeCanonical("𐅑"))).toBe("64f0908591");
    expect(hex(encodeCanonical(new Uint8Array([1, 2, 3, 4])))).toBe(
      "4401020304",
    );
    expect(hex(encodeCanonical(true))).toBe("f5");
    expect(hex(encodeCanonical(false))).toBe("f4");
  });

  test("ID-2: a map's keys sorted by their encoded bytes, shorter first", () => {
    // "b" < "aa": the length is in the first byte (RFC 8949, §4.2.1).
    const a = encodeCanonical({ aa: 1, b: 2, a: 3 });
    const b = encodeCanonical({ b: 2, a: 3, aa: 1 });
    expect(hex(a)).toBe("a3616103616202626161" + "01");
    expect(hex(b)).toBe(hex(a));
    expect(hex(encodeCanonical({}))).toBe("a0");
    expect(hex(encodeCanonical({ n: { m: true } }))).toBe("a1616ea1616df5");
  });

  test("ID-1, ID-3: anything else is refused", () => {
    for (const value of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -Number.MAX_SAFE_INTEGER - 1,
      "\ud800",
      "a\udc00b",
      { k: "\udfff" },
      null,
      undefined,
      [1],
      { k: [] },
      { k: undefined },
      12n,
    ]) {
      expect(() => encodeCanonical(value as never), String(value)).toThrow();
    }
  });
});
