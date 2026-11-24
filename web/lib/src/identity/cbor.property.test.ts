// The strict reading of the canonical encoding (docs/protocol/
// 06-identity.md, ID-2, ID-36): every value of ID-1 reads back as itself;
// and bytes near an encoding — one byte changed, inserted or removed — are
// either refused or the one encoding of what they read as. Never an
// exception: what is read comes from another client or a server.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { type Canonical, decodeCanonical, encodeCanonical } from "./cbor.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];
const MAX = 2 ** 53 - 1;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function value(tc: TC, depth: number): Canonical {
  switch (tc.draw(gs.integers({ minValue: 0, maxValue: depth > 0 ? 4 : 3 }))) {
    case 0:
      return tc.draw(gs.booleans());
    case 1:
      return tc.draw(
        gs.oneOf(
          gs.integers({ minValue: -30, maxValue: 300 }),
          gs.integers({ minValue: -MAX, maxValue: MAX }),
        ),
      );
    case 2:
      return tc.draw(gs.text({ maxSize: 12 }));
    case 3:
      return Uint8Array.from(tc.draw(gs.binary({ maxSize: 40 })));
    default: {
      const map: Record<string, Canonical> = {};
      const keys = tc.draw(gs.arrays(gs.text({ maxSize: 4 }), { maxSize: 4 }));
      for (const key of keys) {
        Object.defineProperty(map, key, {
          value: value(tc, depth - 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return map;
    }
  }
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormedText = (text: string) => !LONE_SURROGATE.test(text);
const wellFormed = (v: Canonical): boolean =>
  typeof v === "string"
    ? wellFormedText(v)
    : typeof v === "object" && !(v instanceof Uint8Array)
      ? Object.entries(v).every(([k, x]) => wellFormedText(k) && wellFormed(x))
      : true;

/** Another encoding of `v`, as a careless encoder would write it: each
 * head in its shortest form or a wider one, each map's keys in an order
 * the test draws. */
function loose(tc: TC, v: Canonical, out: number[]): void {
  const head = (major: number, n: number) => {
    const sizes = [
      n < 24 ? 0 : -1,
      n < 0x100 ? 1 : -1,
      n < 0x10000 ? 2 : -1,
      n < 2 ** 32 ? 4 : -1,
      8,
    ].filter((x) => x >= 0);
    const size = tc.draw(gs.sampledFrom(sizes));
    if (size === 0) {
      out.push((major << 5) | n);
      return;
    }
    out.push((major << 5) | (24 + Math.log2(size)));
    for (let i = size - 1; i >= 0; i--)
      out.push(Math.floor(n / 2 ** (8 * i)) % 256);
  };
  if (typeof v === "boolean") out.push(v ? 0xf5 : 0xf4);
  else if (typeof v === "number") v >= 0 ? head(0, v) : head(1, -1 - v);
  else if (typeof v === "string") {
    const bytes = new TextEncoder().encode(v);
    head(3, bytes.length);
    out.push(...bytes);
  } else if (v instanceof Uint8Array) {
    head(2, v.length);
    out.push(...v);
  } else {
    const entries = Object.entries(v);
    const order = entries.map(
      (_, i) => tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) * 100 + i,
    );
    head(5, entries.length);
    for (const i of [...order].sort((a, b) => a - b).map((o) => o % 100)) {
      const [key, item] = entries[i] as [string, Canonical];
      loose(tc, key, out);
      loose(tc, item, out);
    }
  }
}

describe("the canonical encoding, read strictly", () => {
  test("ID-36: another encoding of a value is refused", () =>
    hegel.test((tc) => {
      const v = value(tc, 2);
      tc.assume(wellFormed(v));
      const out: number[] = [];
      loose(tc, v, out);
      const bytes = Uint8Array.from(out);
      const canonical = hex(bytes) === hex(encodeCanonical(v));
      expect(decodeCanonical(bytes) !== undefined).toBe(canonical);
    }));

  test("ID-2: a value reads back as itself", () =>
    hegel.test((tc) => {
      const v = value(tc, 2);
      tc.assume(wellFormed(v));
      const bytes = encodeCanonical(v);
      const read = decodeCanonical(bytes);
      expect(read).toEqual(v);
      expect(hex(encodeCanonical(read as Canonical))).toBe(hex(bytes));
    }));

  test("ID-36: bytes near an encoding are refused or that of their value", () =>
    hegel.test((tc) => {
      const v = value(tc, 2);
      tc.assume(wellFormed(v));
      const bytes = [...encodeCanonical(v)];
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: bytes.length }));
      const byte = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
      switch (tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))) {
        case 0:
          if (at < bytes.length) bytes[at] = byte;
          break;
        case 1:
          bytes.splice(at, 0, byte);
          break;
        default:
          bytes.splice(at, 1);
      }
      const mutated = Uint8Array.from(bytes);
      const read = decodeCanonical(mutated);
      if (read !== undefined) {
        expect(hex(encodeCanonical(read))).toBe(hex(mutated));
      }
    }));

  test("arbitrary bytes never throw", () =>
    hegel.test((tc) => {
      const bytes = tc.draw(gs.binary({ maxSize: 64 }));
      const read = decodeCanonical(bytes);
      if (read !== undefined) {
        expect(hex(encodeCanonical(read))).toBe(hex(bytes));
      }
    }));
});

test("a key named __proto__ is a key like another", () => {
  const map: Record<string, Canonical> = {};
  Object.defineProperty(map, "__proto__", { value: 1, enumerable: true });
  const read = decodeCanonical(encodeCanonical(map)) as Record<string, unknown>;
  expect(Object.keys(read)).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(read)).toBe(null);
});
