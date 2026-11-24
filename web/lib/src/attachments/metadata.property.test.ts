// What an image says of itself, removed before it is encrypted (ADR-0057
// §1): on images built from drawn segments and chunks, metadata among
// them, the result is the same image without them, in the same order —
// the orientation of a JPEG kept —, recognised as the same format, and
// stripping it again changes nothing; on any bytes at all, no exception.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { type ImageFormat, imageFormat } from "./format.js";
import { readOrientation, stripMetadata } from "./metadata.js";

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
const concat = (parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((part) => Array.from(part)));
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [
  n >>> 24,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];
const le32 = (n: number) => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
  n >>> 24,
];

/** An Exif whose first directory holds `entries` (tag, value), in either
 * byte order. */
function exif(little: boolean, entries: [number, number][]): number[] {
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : be16(n));
  const u32 = (n: number) => (little ? le32(n) : be32(n));
  return [
    ...ascii("Exif"),
    0,
    0,
    ...(little ? ascii("II") : ascii("MM")),
    ...u16(42),
    ...u32(8),
    ...u16(entries.length),
    ...entries.flatMap(([tag, value]) => [
      ...u16(tag),
      ...u16(3),
      ...u32(1),
      ...u16(value),
      0,
      0,
    ]),
    ...u32(0),
  ];
}

describe("metadata removed from an image", () => {
  test("a JPEG keeps its image segments, its profile and its orientation", () =>
    hegel.test((tc) => {
      const little = tc.draw(gs.booleans());
      const orientation = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
      const kinds = tc.draw(
        gs.arrays(
          gs.sampledFrom([
            "jfif",
            "exif",
            "xmp",
            "icc",
            "iptc",
            "adobe",
            "comment",
            "maker",
            "table",
          ]),
          { maxSize: 8 },
        ),
      );
      const kept: number[][] = [];
      let exifs = 0;
      const segments = kinds.map((kind) => {
        const filler = tc.draw(gs.binary({ maxSize: 12 }));
        const segment = (marker: number, data: number[] | Uint8Array) => [
          0xff,
          marker,
          ...be16(data.length + 2),
          ...data,
        ];
        switch (kind) {
          case "exif": {
            exifs++;
            return segment(
              0xe1,
              exif(little, [
                [0x010f, 7],
                [0x0112, orientation],
                [0x8825, 9],
              ]),
            );
          }
          case "xmp":
            return segment(0xe1, [
              ...ascii("http://ns.adobe.com/xap/1.0/"),
              0,
              ...filler,
            ]);
          case "iptc":
            return segment(0xed, [...ascii("Photoshop 3.0"), 0, ...filler]);
          case "comment":
            return segment(0xfe, filler);
          case "maker":
            return segment(0xe3 + (filler.length % 9), filler);
          default: {
            const marker =
              { jfif: 0xe0, icc: 0xe2, adobe: 0xee, table: 0xdb }[kind] ?? 0xdb;
            const s = segment(marker, filler);
            kept.push(s);
            return s;
          }
        }
      });
      const scan = [
        0xff,
        0xda,
        0,
        2,
        ...tc.draw(gs.binary({ maxSize: 16 })),
        0xff,
        0xd9,
      ];
      const image = concat([[0xff, 0xd8], ...segments, scan]);

      const out = stripMetadata(image, "jpeg");

      expect(out).not.toBeNull();
      const restored = orientation >= 2 && exifs > 0 ? exifs : 0;
      const segment = 4 + 6 + 26;
      expect(out?.length).toBe(
        2 +
          kept.reduce((n, s) => n + s.length, 0) +
          restored * segment +
          scan.length,
      );
      expect(imageFormat(out as Uint8Array)).toBe("jpeg");
      const text = Buffer.from(out as Uint8Array).toString("latin1");
      for (const word of ["http://ns.adobe.com", "Photoshop"])
        expect(text).not.toContain(word);
      if (restored > 0) {
        const at = text.indexOf("Exif\0\0");
        expect(readOrientation((out as Uint8Array).subarray(at + 6))).toBe(
          orientation,
        );
        // Nothing but the orientation: a single entry.
        expect((out as Uint8Array)[at + 6 + 9]).toBe(1);
      }
      expect(stripMetadata(out as Uint8Array, "jpeg")).toEqual(out);
    }));

  test("a PNG keeps every chunk but eXIf and its texts, and nothing after IEND", () =>
    hegel.test((tc) => {
      const types = tc.draw(
        gs.arrays(
          gs.sampledFrom([
            "IHDR",
            "PLTE",
            "IDAT",
            "iCCP",
            "tEXt",
            "zTXt",
            "iTXt",
            "eXIf",
            "tIME",
          ]),
          { maxSize: 8 },
        ),
      );
      const chunk = (type: string, data: Uint8Array) => [
        ...be32(data.length),
        ...ascii(type),
        ...data,
        0,
        0,
        0,
        0,
      ];
      const all = types.map((type) => ({
        type,
        bytes: chunk(type, tc.draw(gs.binary({ maxSize: 10 }))),
      }));
      const end = chunk("IEND", new Uint8Array(0));
      const trailing = tc.draw(gs.binary({ maxSize: 6 }));
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const image = concat([
        signature,
        ...all.map((c) => c.bytes),
        end,
        trailing,
      ]);

      const out = stripMetadata(image, "png");

      const kept = all.filter(
        (c) => !["tEXt", "zTXt", "iTXt", "eXIf"].includes(c.type),
      );
      expect(out).toEqual(
        concat([signature, ...kept.map((c) => c.bytes), end]),
      );
      expect(imageFormat(out as Uint8Array)).toBe("png");
      expect(stripMetadata(out as Uint8Array, "png")).toEqual(out);
    }));

  test("a WebP keeps every chunk but EXIF and XMP, and says it has none", () =>
    hegel.test((tc) => {
      const types = tc.draw(
        gs.arrays(
          gs.sampledFrom([
            "VP8 ",
            "VP8L",
            "ALPH",
            "ICCP",
            "EXIF",
            "XMP ",
            "ANIM",
          ]),
          { maxSize: 6 },
        ),
      );
      const flags = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
      const chunk = (type: string, data: number[] | Uint8Array) => [
        ...ascii(type),
        ...le32(data.length),
        ...data,
        ...(data.length % 2 ? [0] : []),
      ];
      const vp8x = chunk("VP8X", [flags, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
      const all = types.map((type) => ({
        type,
        bytes: chunk(type, tc.draw(gs.binary({ maxSize: 9 }))),
      }));
      const body = concat([ascii("WEBP"), vp8x, ...all.map((c) => c.bytes)]);
      const image = concat([ascii("RIFF"), le32(body.length), body]);

      const out = stripMetadata(image, "webp") as Uint8Array;

      const kept = all.filter((c) => c.type !== "EXIF" && c.type !== "XMP ");
      const cleared = [...vp8x];
      cleared[8] = flags & ~0x0c;
      const expectedBody = concat([
        ascii("WEBP"),
        cleared,
        ...kept.map((c) => c.bytes),
      ]);
      expect(out).toEqual(
        concat([ascii("RIFF"), le32(expectedBody.length), expectedBody]),
      );
      expect(imageFormat(out)).toBe("webp");
      expect(stripMetadata(out, "webp")).toEqual(out);
    }));

  test("any bytes, in any format: no exception", () =>
    hegel.test((tc) => {
      const format = tc.draw(
        gs.sampledFrom<ImageFormat>([
          "jpeg",
          "png",
          "webp",
          "gif",
          "avif",
          "svg",
        ]),
      );
      const prefix =
        {
          jpeg: [0xff, 0xd8],
          png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          webp: [...ascii("RIFF")],
        }[format as "jpeg" | "png" | "webp"] ?? [];
      const bytes = concat([prefix, tc.draw(gs.binary({ maxSize: 64 }))]);
      stripMetadata(bytes, format);
      readOrientation(bytes);
      imageFormat(bytes);
    }));
});

describe("metadata, by example", () => {
  test("a JPEG without its scan is not well formed: refused", () => {
    expect(
      stripMetadata(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]),
        "jpeg",
      ),
    ).toBeNull();
    expect(
      stripMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 9]), "jpeg"),
    ).toBeNull();
  });

  test("a PNG without IEND, or a chunk longer than the file: refused", () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(stripMetadata(Uint8Array.from(signature), "png")).toBeNull();
    expect(
      stripMetadata(
        concat([signature, be32(100), ascii("IDAT"), [0, 0, 0, 0]]),
        "png",
      ),
    ).toBeNull();
  });

  test("the default orientation isn't kept: nothing to say", () => {
    const image = concat([
      [0xff, 0xd8],
      [0xff, 0xe1, ...be16(2 + exif(false, [[0x0112, 1]]).length)],
      exif(false, [[0x0112, 1]]),
      [0xff, 0xda, 0, 2, 0xff, 0xd9],
    ]);
    expect(stripMetadata(image, "jpeg")).toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]),
    );
  });

  test("a GIF, an AVIF or an SVG is kept whole", () => {
    const bytes = Uint8Array.from(ascii("GIF89a<!-- -->"));
    for (const format of ["gif", "avif", "svg"] as const)
      expect(stripMetadata(bytes, format)).toBe(bytes);
  });
});
