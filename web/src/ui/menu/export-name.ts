import { documentTitle } from "../document-title.js";

/** What a file name can't hold on one of the systems an export may land
 * on (Windows, macOS, Linux), or in an Obsidian vault (`#^[]`, its links'
 * syntax); control characters; and the invisible ones (zero widths,
 * bidirectional overrides, a lone surrogate), which would make a name
 * read as another. */
const REFUSED =
  /[\\/:*?"<>|#^[\]\p{Cc}\p{Cs}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

/** Names Windows keeps for its devices, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** The longest name, in bytes (most file systems). */
const MAX_BYTES = 255;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** No hidden file (a leading dot), nothing Windows drops (a trailing dot
 * or space). */
const trimmed = (text: string) => text.replace(/^[ .]+|[ .]+$/g, "");

/** The name an export of `text` is saved under: its title as the header
 * shows it, what no file can hold made a space, cut at a character to fit
 * with `suffix`; « document » if nothing is left. */
export function exportName(text: string, suffix: string): string {
  const title = trimmed(
    (documentTitle(text) ?? "").replace(REFUSED, " ").replace(/\s+/g, " "),
  );
  let base = "";
  for (const character of title) {
    if (bytes(base + character + suffix) > MAX_BYTES - 1) break;
    base += character;
  }
  base = trimmed(base);
  if (base === "") base = "document";
  if (RESERVED.test(base)) base += "_";
  return base + suffix;
}
