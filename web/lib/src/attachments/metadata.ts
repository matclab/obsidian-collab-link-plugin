/** What an image says of where and how it was made, removed before it is
 * encrypted (ADR-0057 §1): every reader of the document would read it.
 * On the bytes, never re-encoded: a JPEG loses its Exif (the position of
 * a phone's photo among it) but keeps its orientation, rewritten alone,
 * else a photo would show turned; its XMP, IPTC, comments and the other
 * makers' segments; never its colour profile (APP2) nor Adobe's (APP14),
 * which carry no text and without which colours change. A PNG loses its
 * `eXIf` and text chunks, a WebP its `EXIF` and `XMP ` chunks. Pure. */
import type { ImageFormat } from "./format.js";

/** The byte at `i`; 0 beyond the end, where every caller checks the
 * length first. */
const byte = (bytes: Uint8Array, i: number): number => bytes[i] ?? 0;

class Bytes {
  private readonly parts: Uint8Array[] = [];
  push(part: Uint8Array | number[]): void {
    this.parts.push(part instanceof Uint8Array ? part : Uint8Array.from(part));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** The bytes without their metadata, or `null` for bytes not well formed
 * enough to tell what they hold: never uploaded as they are. Other
 * formats are kept whole. */
export function stripMetadata(
  bytes: Uint8Array,
  format: ImageFormat,
): Uint8Array | null {
  switch (format) {
    case "jpeg":
      return stripJpeg(bytes);
    case "png":
      return stripPng(bytes);
    case "webp":
      return stripWebp(bytes);
    default:
      return bytes;
  }
}

/** APP0 (JFIF), APP2 (ICC profile), APP14 (Adobe): kept. */
const KEPT_APP = new Set([0xe0, 0xe2, 0xee]);
const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];

function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const out = new Bytes();
  out.push([0xff, 0xd8]);
  let i = 2;
  while (i < bytes.length) {
    if (byte(bytes, i) !== 0xff) return null;
    while (byte(bytes, i) === 0xff) i++; // fill bytes
    if (i >= bytes.length) return null;
    const marker = byte(bytes, i++);
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push([0xff, marker]);
      continue;
    }
    if (marker === 0xd9) {
      out.push([0xff, 0xd9]);
      return out.done();
    }
    if (i + 2 > bytes.length) return null;
    const length = (byte(bytes, i) << 8) | byte(bytes, i + 1);
    if (length < 2 || i + length > bytes.length) return null;
    const data = bytes.subarray(i + 2, i + length);
    if (marker === 0xda) {
      // The scan, and whatever follows it: image data.
      out.push(bytes.subarray(i - 2));
      return out.done();
    }
    const app = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xe1 && EXIF.every((b, k) => byte(data, k) === b)) {
      const orientation = readOrientation(data.subarray(6));
      if (orientation !== null) out.push(orientationSegment(orientation));
    } else if (!((app && !KEPT_APP.has(marker)) || marker === 0xfe)) {
      out.push(bytes.subarray(i - 2, i + length));
    }
    i += length;
  }
  return null;
}

/** The orientation of an Exif's first directory (tag 0x0112), if not the
 * default one. */
export function readOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = byte(tiff, 0) === 0x49 && byte(tiff, 1) === 0x49;
  const big = byte(tiff, 0) === 0x4d && byte(tiff, 1) === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number) =>
    little
      ? byte(tiff, at) | (byte(tiff, at + 1) << 8)
      : (byte(tiff, at) << 8) | byte(tiff, at + 1);
  const u32 = (at: number) =>
    little
      ? (byte(tiff, at) |
          (byte(tiff, at + 1) << 8) |
          (byte(tiff, at + 2) << 16)) +
        byte(tiff, at + 3) * 2 ** 24
      : byte(tiff, at) * 2 ** 24 +
        ((byte(tiff, at + 1) << 16) |
          (byte(tiff, at + 2) << 8) |
          byte(tiff, at + 3));
  if (u16(2) !== 42) return null;
  const directory = u32(4);
  if (directory + 2 > tiff.length) return null;
  const count = u16(directory);
  for (let n = 0; n < count; n++) {
    const entry = directory + 2 + 12 * n;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 2 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An APP1 that holds nothing but an orientation. */
function orientationSegment(orientation: number): number[] {
  const tiff = [
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8, // big-endian, directory at 8
    0,
    1, // one entry
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0, // no next directory
  ];
  const length = 2 + EXIF.length + tiff.length;
  return [0xff, 0xe1, length >> 8, length & 0xff, ...EXIF, ...tiff];
}

const PNG_DROPPED = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

function stripPng(bytes: Uint8Array): Uint8Array | null {
  const out = new Bytes();
  out.push(bytes.subarray(0, 8));
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length =
      byte(bytes, i) * 2 ** 24 +
      ((byte(bytes, i + 1) << 16) |
        (byte(bytes, i + 2) << 8) |
        byte(bytes, i + 3));
    const end = i + 12 + length;
    if (end > bytes.length) return null;
    const type = fourcc(bytes, i + 4);
    if (!PNG_DROPPED.has(type)) out.push(bytes.subarray(i, end));
    // Nothing after the end: bytes there would travel unseen.
    if (type === "IEND") return out.done();
    i = end;
  }
  return null;
}

const WEBP_DROPPED = new Set(["EXIF", "XMP "]);
/** VP8X's flags of an Exif and of an XMP chunk. */
const VP8X_METADATA = 0x08 | 0x04;

function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const size =
    byte(bytes, 4) |
    (byte(bytes, 5) << 8) |
    (byte(bytes, 6) << 16) |
    (byte(bytes, 7) * 2 ** 24);
  const end = 8 + size;
  if (end > bytes.length || size < 4) return null;
  const chunks = new Bytes();
  let i = 12;
  while (i < end) {
    if (i + 8 > end) return null;
    const type = fourcc(bytes, i);
    const length =
      byte(bytes, i + 4) |
      (byte(bytes, i + 5) << 8) |
      (byte(bytes, i + 6) << 16) |
      (byte(bytes, i + 7) * 2 ** 24);
    const next = i + 8 + length + (length % 2);
    if (i + 8 + length > end) return null;
    if (!WEBP_DROPPED.has(type)) {
      const chunk = bytes.slice(i, Math.min(next, end));
      if (type === "VP8X" && length > 0)
        chunk[8] = byte(chunk, 8) & ~VP8X_METADATA;
      chunks.push(chunk);
    }
    i = next;
  }
  const body = chunks.done();
  const riff = 4 + body.length;
  const out = new Bytes();
  out.push([
    0x52,
    0x49,
    0x46,
    0x46,
    riff & 0xff,
    (riff >> 8) & 0xff,
    (riff >> 16) & 0xff,
    riff >>> 24,
  ]);
  out.push([0x57, 0x45, 0x42, 0x50]);
  out.push(body);
  return out.done();
}
