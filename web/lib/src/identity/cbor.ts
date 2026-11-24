/** The canonical encoding of what is signed (docs/protocol/06-identity.md,
 * §6.2): deterministic CBOR (RFC 8949, §4.2.1), reduced to maps with text
 * keys, texts, bytes, safe integers and booleans (ID-1). One value has one
 * encoding (ID-2); a text with a lone surrogate is refused, never replaced
 * (ID-3): the value signed must be the value displayed (SG1). Bytes in,
 * bytes out. A client rebuilds the message of an object it verifies; it
 * reads only what a gateway signed (ID-36), and strictly: the bytes must
 * be the one encoding of what they decode to. */

export type Canonical =
  | boolean
  | number
  | string
  | Uint8Array
  | { readonly [key: string]: Canonical };

const encoder = new TextEncoder();

/** A high surrogate not followed by a low one, or a low one not preceded
 * by a high one. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The major type and its argument, in the shortest form (ID-2). */
function head(major: number, argument: number, out: number[]): void {
  const m = major << 5;
  if (argument < 24) out.push(m | argument);
  else if (argument < 0x100) out.push(m | 24, argument);
  else if (argument < 0x10000) out.push(m | 25, argument >> 8, argument & 0xff);
  else if (argument < 0x100000000) {
    out.push(m | 26);
    for (let shift = 24; shift >= 0; shift -= 8) {
      out.push(Math.floor(argument / 2 ** shift) & 0xff);
    }
  } else {
    out.push(m | 27);
    // Below 2⁵³: the high 32 bits, then the low ones.
    const high = Math.floor(argument / 0x100000000);
    const low = argument % 0x100000000;
    for (const part of [high, low]) {
      for (let shift = 24; shift >= 0; shift -= 8) {
        out.push(Math.floor(part / 2 ** shift) & 0xff);
      }
    }
  }
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

function encodeInto(value: unknown, out: number[]): void {
  if (typeof value === "boolean") {
    out.push(value ? 0xf5 : 0xf4);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("only integers below 2⁵³ are encoded (ID-1)");
    }
    if (value >= 0) head(0, value, out);
    else head(1, -1 - value, out);
  } else if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) {
      throw new TypeError("a text with a lone surrogate (ID-3)");
    }
    const bytes = encoder.encode(value);
    head(3, bytes.length, out);
    for (const byte of bytes) out.push(byte);
  } else if (value instanceof Uint8Array) {
    head(2, value.length, out);
    for (const byte of value) out.push(byte);
  } else if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const entries = Object.entries(value).map(([key, item]) => {
      const encodedKey: number[] = [];
      encodeInto(key, encodedKey);
      return [encodedKey, item] as const;
    });
    entries.sort(([a], [b]) => compare(a, b));
    head(5, entries.length, out);
    for (const [encodedKey, item] of entries) {
      for (const byte of encodedKey) out.push(byte);
      encodeInto(item, out);
    }
  } else {
    throw new TypeError(`not encodable (ID-1): ${typeof value}`);
  }
}

/** The canonical encoding of `value`; throws on anything ID-1 and ID-3
 * leave out. */
export function encodeCanonical(value: Canonical): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SAFE = 2 ** 53 - 1;
/** Deeper than any message of §6.8 – §6.10. */
const MAX_DEPTH = 8;

class Malformed extends Error {}

/** The value at `at`, and where it ends. Throws `Malformed`. */
function read(
  bytes: Uint8Array,
  at: number,
  depth: number,
): [Canonical, number] {
  if (depth > MAX_DEPTH || at >= bytes.length) throw new Malformed();
  const initial = bytes[at] as number;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let next = at + 1;
  if (major === 7) {
    if (info === 20) return [false, next];
    if (info === 21) return [true, next];
    throw new Malformed();
  }
  // The argument; 28 to 31 (indefinite, reserved) are not of ID-2.
  let argument: number;
  if (info < 24) argument = info;
  else if (info <= 27) {
    const size = 2 ** (info - 24);
    if (next + size > bytes.length) throw new Malformed();
    argument = 0;
    for (let i = 0; i < size; i++) {
      argument = argument * 256 + (bytes[next + i] as number);
    }
    next += size;
    if (argument > MAX_SAFE) throw new Malformed();
  } else throw new Malformed();
  switch (major) {
    case 0:
      return [argument, next];
    case 1:
      if (argument >= MAX_SAFE) throw new Malformed();
      return [-1 - argument, next];
    case 2:
    case 3: {
      if (next + argument > bytes.length) throw new Malformed();
      const content = bytes.slice(next, next + argument);
      next += argument;
      if (major === 2) return [content, next];
      try {
        return [decoder.decode(content), next];
      } catch {
        throw new Malformed();
      }
    }
    case 5: {
      // At least two bytes an entry: no loop beyond what is there.
      if (argument * 2 > bytes.length - next) throw new Malformed();
      const map: Record<string, Canonical> = Object.create(null);
      for (let i = 0; i < argument; i++) {
        const [key, afterKey] = read(bytes, next, depth + 1);
        if (typeof key !== "string") throw new Malformed();
        const [item, afterItem] = read(bytes, afterKey, depth + 1);
        Object.defineProperty(map, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        next = afterItem;
      }
      return [map, next];
    }
    default:
      // Arrays and tags are not of ID-1.
      throw new Malformed();
  }
}

/** The value `bytes` are the canonical encoding of (ID-36), or
 * `undefined`: anything else — another form of the same value (a length
 * not in its shortest form, keys out of order, a key repeated), a float,
 * an array, a tag, an indefinite length, invalid UTF-8, bytes left over.
 * Never throws. Maps have no prototype: a key `__proto__` is a key. */
export function decodeCanonical(bytes: Uint8Array): Canonical | undefined {
  try {
    const [value, end] = read(bytes, 0, 0);
    if (end !== bytes.length) return undefined;
    const again = encodeCanonical(value);
    return again.length === bytes.length &&
      again.every((b, i) => b === bytes[i])
      ? value
      : undefined;
  } catch (error) {
    if (error instanceof Malformed) return undefined;
    throw error;
  }
}
