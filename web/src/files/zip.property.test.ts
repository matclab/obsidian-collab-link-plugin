// The export's zip (ADR-0057 §8), read back by a reader written here from
// the format (APPNOTE), with Node's own CRC: the same files, in order,
// byte for byte, under their names.
import { crc32 as nodeCrc } from "node:zlib";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { crc32, zip } from "./zip.js";

function unzip(archive: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const end = archive.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (let n = 0; n < count; n++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      archive.subarray(at + 46, at + 46 + nameLength),
    );
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint16(local + 8, true), "stored").toBe(0);
    const localName = view.getUint16(local + 26, true);
    const data = local + 30 + localName + view.getUint16(local + 28, true);
    const bytes = archive.subarray(data, data + size);
    expect(nodeCrc(bytes) >>> 0).toBe(crc);
    files.push({ name, bytes });
    at += 46 + nameLength;
  }
  return files;
}

describe("the export's zip", () => {
  test("read back: the same files, in order, under their names", () =>
    hegel.test((tc) => {
      const entries = tc
        .draw(
          gs.arrays(
            gs.tuples(
              gs.text({ minSize: 1, maxSize: 12 }),
              gs.binary({ maxSize: 300 }),
            ),
            { maxSize: 6 },
          ),
        )
        .map(([name, bytes]) => ({ name, bytes }));
      const read = unzip(zip(entries));
      expect(read.map((f) => [f.name, Array.from(f.bytes)])).toEqual(
        entries.map((e) => [e.name, Array.from(e.bytes)]),
      );
    }));

  test("its CRC is Node's", () =>
    hegel.test((tc) => {
      const bytes = tc.draw(gs.binary({ maxSize: 500 }));
      expect(crc32(bytes)).toBe(nodeCrc(bytes) >>> 0);
    }));
});
