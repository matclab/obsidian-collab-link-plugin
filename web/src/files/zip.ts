/** A zip archive of files stored as they are, without compression
 * (ADR-0057 §8: an export with its images, which are compressed
 * already). Pure, without a dependency: local headers, the central
 * directory, its end; names in UTF-8 (flag 11). Fewer than 65 535 files
 * and 4 GiB in all: an export is far from it. */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO 3309), as zip computes it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  length = 0;
  bytes(part: Uint8Array): void {
    this.parts.push(part);
    this.length += part.length;
  }
  u16(n: number): void {
    this.bytes(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff));
  }
  u32(n: number): void {
    this.bytes(
      Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24),
    );
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** Version 2.0, UTF-8 names, stored, no date (1980-01-01). */
const VERSION = 20;
const UTF8 = 1 << 11;
const DOS_DATE = (1 << 5) | 1;

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const out = new Writer();
  const central = new Writer();
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const offset = out.length;
    const header = (w: Writer, central: boolean) => {
      w.u32(central ? 0x02014b50 : 0x04034b50);
      if (central) w.u16(VERSION);
      w.u16(VERSION);
      w.u16(UTF8);
      w.u16(0); // stored
      w.u16(0);
      w.u16(DOS_DATE);
      w.u32(crc);
      w.u32(entry.bytes.length);
      w.u32(entry.bytes.length);
      w.u16(name.length);
      w.u16(0);
      if (central) {
        w.u16(0); // comment
        w.u16(0); // disk
        w.u16(0); // internal attributes
        w.u32(0); // external attributes
        w.u32(offset);
      }
      w.bytes(name);
    };
    header(out, false);
    out.bytes(entry.bytes);
    header(central, true);
  }
  const directory = central.done();
  const start = out.length;
  out.bytes(directory);
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(directory.length);
  out.u32(start);
  out.u16(0);
  return out.done();
}
