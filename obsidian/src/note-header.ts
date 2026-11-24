import type { Frontiers } from "loro-crdt";

/** What the exported file carries besides `content`
 * (docs/phase-14-plugin-obsidian.md, decision 3): the document's id, not a
 * secret (the server and the browser's history know it), and the version
 * the export reflects, Loro's frontiers in clear (nothing of the text). */
export interface NoteHeader {
  document: string;
  version: string;
}

const DOCUMENT_LINE = /^collab-document: "([A-Za-z0-9_-]+)"\n/;
const VERSION_LINE = /^collab-version: "([0-9@ ]*)"\n/;

/** `content` opens with a YAML header, closed, with at least a line. */
function hasHeader(content: string): boolean {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) return false;
  const rest = content.slice(opening[0].length);
  if (/^---(\r?\n|$)/.test(rest)) return false; // empty: nothing to add to
  return /(^|\n)---(\r?\n|$)/.test(rest);
}

/** The file for `content`: the two properties first in its YAML header,
 * where Obsidian shows them, `content`'s own after them; a header of
 * their own when `content` has none, or an empty one. */
export function writeHeader(content: string, header: NoteHeader): string {
  const ours = `collab-document: "${header.document}"\ncollab-version: "${header.version}"\n`;
  if (hasHeader(content)) {
    const opening = /^---\r?\n/.exec(content)?.[0] ?? "---\n";
    return `${opening}${ours}${content.slice(opening.length)}`;
  }
  return `---\n${ours}---\n${content}`;
}

/** `content` and the header of a file `writeHeader` wrote; any other file
 * is all `content`, with no header. */
export function readHeader(file: string): {
  content: string;
  header: NoteHeader | undefined;
} {
  const none = { content: file, header: undefined };
  const opening = /^---\r?\n/.exec(file);
  if (!opening) return none;
  let rest = file.slice(opening[0].length);
  const document = DOCUMENT_LINE.exec(rest);
  if (!document) return none;
  rest = rest.slice(document[0].length);
  const version = VERSION_LINE.exec(rest);
  if (!version) return none;
  rest = rest.slice(version[0].length);
  const header = { document: document[1] ?? "", version: version[1] ?? "" };
  // A header of their own, or `content`'s, which they open.
  const content = rest.startsWith("---\n")
    ? rest.slice("---\n".length)
    : `${opening[0]}${rest}`;
  // Only what `writeHeader` writes: anything else is text.
  return writeHeader(content, header) === file ? { content, header } : none;
}

const MAX_PEER = 2n ** 64n - 1n;

/** Frontiers as `counter@peer`, by peer: the same version, the same
 * text. */
export function formatVersion(frontiers: Frontiers): string {
  return [...frontiers]
    .sort((a, b) => {
      const [x, y] = [BigInt(a.peer), BigInt(b.peer)];
      return x < y ? -1 : x > y ? 1 : a.counter - b.counter;
    })
    .map(({ peer, counter }) => `${counter}@${peer}`)
    .join(" ");
}

/** The frontiers of `formatVersion`'s text, or `undefined` for anything
 * else. */
export function parseVersion(text: string): Frontiers | undefined {
  if (text === "") return [];
  const frontiers: Frontiers = [];
  for (const part of text.split(" ")) {
    const match = /^(\d{1,10})@(\d{1,20})$/.exec(part);
    if (!match) return undefined;
    const counter = Number(match[1]);
    const peer = BigInt(match[2] ?? "");
    if (counter > 2 ** 31 - 1 || peer > MAX_PEER) return undefined;
    frontiers.push({ peer: `${peer}` as `${number}`, counter });
  }
  return frontiers;
}

const LOOSE_LINE =
  /^collab-(document|version):[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^"'\r\n]*?))[ \t]*$/;

/** `collab-document` and `collab-version` however another tool wrote them:
 * anywhere in the YAML header that opens the file, quoted or not, the first of
 * each; the text is the file without them, and without the header if nothing
 * else is left in it. A file without `collab-document` is all text. */
export function readLooseHeader(file: string): {
  content: string;
  document?: string;
  version?: string;
} {
  const none = { content: file };
  const opening = /^---\r?\n/.exec(file);
  if (!opening) return none;
  const found: { document?: string; version?: string } = {};
  let kept = "";
  for (let at = opening[0].length; at < file.length; ) {
    const end = file.indexOf("\n", at);
    const next = end === -1 ? file.length : end + 1;
    const line = file.slice(at, next);
    const bare = line.replace(/\r?\n$/, "");
    if (bare === "---") {
      if (found.document === undefined) return none;
      const rest = file.slice(next);
      const content = kept === "" ? rest : `${opening[0]}${kept}${line}${rest}`;
      return { content, ...found };
    }
    const match = LOOSE_LINE.exec(bare);
    const name = match?.[1] as "document" | "version" | undefined;
    const value = match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
    // A document is named as the server names it, or isn't ours.
    const fits = name !== "document" || /^[A-Za-z0-9_-]+$/.test(value);
    if (name && fits && found[name] === undefined) found[name] = value;
    else kept += line;
    at = next;
  }
  return none; // never closed: not a header
}
