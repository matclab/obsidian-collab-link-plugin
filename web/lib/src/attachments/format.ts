/** The formats an attached image may have (docs/protocol/03-document.md,
 * D-40), recognised by its bytes alone, never by a name or a declared
 * type. Pure. */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "avif" | "svg";

/** The media type a format is shown under. */
export const MEDIA_TYPES: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

function at(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return (
    bytes.length >= offset + expected.length &&
    expected.every((byte, i) => bytes[offset + i] === byte)
  );
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The format of an image's bytes, or `null` if it is none of D-40's. */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  if (at(bytes, 0, PNG)) return "png";
  if (at(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (at(bytes, 0, ascii("GIF87a")) || at(bytes, 0, ascii("GIF89a")))
    return "gif";
  if (at(bytes, 0, ascii("RIFF")) && at(bytes, 8, ascii("WEBP"))) return "webp";
  if (at(bytes, 4, ascii("ftypavif")) || at(bytes, 4, ascii("ftypavis")))
    return "avif";
  return isSvg(bytes) ? "svg" : null;
}

const SPACE = /^[ \t\r\n]*/;

/** UTF-8 text whose first element, after white space, an XML declaration,
 * comments and a document type declaration, is `<svg`, then white space,
 * `>` or `/` (D-40). */
function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let rest = text.startsWith("﻿") ? text.slice(1) : text;
  for (;;) {
    rest = rest.replace(SPACE, "");
    const skipped = skipProlog(rest);
    if (skipped === null) return false;
    if (skipped === rest) break;
    rest = skipped;
  }
  return /^<svg[ \t\r\n>/]/.test(rest);
}

/** `rest` after one declaration, comment or doctype at its start; `rest`
 * itself if none starts it; `null` if one starts it unclosed. */
function skipProlog(rest: string): string | null {
  const close = (opening: string, closing: string) => {
    const end = rest.indexOf(closing, opening.length);
    return end < 0 ? null : rest.slice(end + closing.length);
  };
  if (rest.startsWith("<?xml")) return close("<?xml", "?>");
  if (rest.startsWith("<!--")) return close("<!--", "-->");
  if (rest.startsWith("<!DOCTYPE")) {
    // An internal subset in brackets may hold a `>`.
    let depth = 0;
    for (let i = "<!DOCTYPE".length; i < rest.length; i++) {
      const c = rest[i];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) return rest.slice(i + 1);
    }
    return null;
  }
  return rest;
}
