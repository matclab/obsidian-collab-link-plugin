// The test vectors of the protocol specification (docs/protocol/
// vectors.json), for the tests that check this client against them. The
// same file is read by the server's tests: neither side may drift from the
// specification on what is mechanical. Tests only.
import { readFileSync } from "node:fs";

// biome-ignore lint/suspicious/noExplicitAny: JSON read as is; each test narrows what it reads.
export const vectors: any = JSON.parse(
  readFileSync(
    new URL("../../../../docs/protocol/vectors.json", import.meta.url),
    "utf8",
  ),
);

export function fromHex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "hex"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A text given as its UTF-16 code units, four hex digits each: what JSON
 * can't carry to every parser (a lone surrogate). */
export function fromUtf16(text: string): string {
  return String.fromCharCode(
    ...(text.match(/.{4}/g) ?? []).map((unit) => Number.parseInt(unit, 16)),
  );
}
