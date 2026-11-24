// A note's links at the edges of sharing (docs/phase-19-liens.md,
// decisions 1 to 4 and 9; ADR-0045 §4). Sharing — and typing in a linked
// note, and the command — writes a `[[B]]` to a linked note as its
// document's address without the key, the name as written shown; one to
// this note, `[[#Titre]]`. Unlinking writes the addresses of this vault's
// notes back as their names. Pure: the caller resolves names (Obsidian's
// metadataCache), and applies the edits — to the document, never to the
// file (LK2).
import { documentLinksIn, wikilinksIn } from "../../web/src/embed.js";
import type { WikilinkRange } from "../../web/src/embed.js";

/** A linked note's document, and its server's page (`origin` + path). */
export interface LinkedTarget {
  documentId: string;
  base: string;
}

/** A `[[…]]`'s note, from this one: a linked note's document, this note,
 * or neither (not a note, or not linked). */
export type Resolve = (linkpath: string) => LinkedTarget | "self" | undefined;

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** `[`, `]` and `\` escaped: a link's text. */
const asLinkText = (text: string) => text.replace(/[[\]\\]/g, "\\$&");

/** The address without the key of `target`'s document, at `heading`. */
function address(target: LinkedTarget, heading: string): string {
  const h = heading ? `#h=${encodeURIComponent(heading)}` : "";
  return `${target.base}?doc=${encodeURIComponent(target.documentId)}${h}`;
}

/** The edits that write `text`'s `[[…]]` to linked notes as addresses, and
 * to this note as `[[#…]]`; only those `wanted` says, if given. A block
 * (`#^…`) stays as written: the page doesn't follow one. An address the
 * text around would read otherwise (after a `]`, a reference link) is
 * left out: its `[[…]]` stays, a link to a note of this vault (LK3). */
export function toAddresses(
  text: string,
  resolve: Resolve,
  wanted?: (link: WikilinkRange) => boolean,
): Edit[] {
  let edits = candidates(text, resolve, wanted);
  for (;;) {
    const read = readBack(text, edits);
    if (read.length === edits.length) return edits;
    edits = read;
  }
}

/** The edits whose address reads back, at its place, as a link: those to
 * `[[#…]]` stay. */
function readBack(text: string, edits: readonly Edit[]): Edit[] {
  const written = applyEdits(text, edits);
  const origins = new Set<string>();
  for (const edit of edits) {
    const url = /\]\(([^)]*)\)$/.exec(edit.insert)?.[1];
    if (url) origins.add(new URL(url).origin);
  }
  const links = new Set<number>();
  for (const origin of origins) {
    for (const found of documentLinksIn(written, origin)) links.add(found.from);
  }
  let shift = 0;
  return edits.filter((edit) => {
    const at = edit.from + shift;
    shift += edit.insert.length - (edit.to - edit.from);
    return edit.insert.startsWith("[[") || links.has(at);
  });
}

/** Every edit `toAddresses` would make, before reading them back. */
function candidates(
  text: string,
  resolve: Resolve,
  wanted?: (link: WikilinkRange) => boolean,
): Edit[] {
  const edits: Edit[] = [];
  for (const link of wikilinksIn(text)) {
    if (link.kind !== "note" || (wanted && !wanted(link))) continue;
    const at = link.target.indexOf("#");
    const path = at < 0 ? link.target : link.target.slice(0, at);
    const heading = at < 0 ? "" : link.target.slice(at + 1);
    if (heading.startsWith("^")) continue;
    const found = resolve(path);
    if (!found) continue;
    if (found === "self") {
      if (heading === "") continue;
      const alias = link.alias === null ? "" : `|${link.alias}`;
      edits.push({
        from: link.from,
        to: link.to,
        insert: `[[#${heading}${alias}]]`,
      });
      continue;
    }
    const shown = asLinkText(link.alias ?? link.target);
    edits.push({
      from: link.from,
      to: link.to,
      insert: `[${shown}](${address(found, heading)})`,
    });
  }
  return edits;
}

/** The edits that write `text`'s addresses of `origin`'s documents back as
 * `[[…]]` to this vault's notes, named by `nameOf` (a link text from this
 * note); a text that a `[[…]]` can't hold (a bracket, a line break) stays
 * an address. */
export function toWikilinks(
  text: string,
  origin: string,
  nameOf: (documentId: string) => string | undefined,
): Edit[] {
  const edits: Edit[] = [];
  for (const link of documentLinksIn(text, origin)) {
    const name = nameOf(link.documentId);
    if (!name) continue;
    const target = link.heading ? `${name}#${link.heading}` : name;
    if (link.text !== null && /[[\]\n]/.test(link.text)) continue;
    const alias =
      link.text === null || link.text === target ? "" : `|${link.text}`;
    edits.push({
      from: link.from,
      to: link.to,
      insert: `[[${target}${alias}]]`,
    });
  }
  return edits;
}

/** `text` with `edits` made (in order, none overlapping). */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = "";
  let at = 0;
  for (const edit of edits) {
    out += text.slice(at, edit.from) + edit.insert;
    at = edit.to;
  }
  return out + text.slice(at);
}

/** A note renamed, from path to path (Obsidian's `rename` event). */
export interface Rename {
  from: string;
  to: string;
}

/** How a `[[…]]` may name the note at `path`: with or without its
 * folder, with or without `.md`. */
function namesOfPath(path: string): Set<string> {
  const bare = path.replace(/\.md$/, "");
  const name = bare.split("/").pop() ?? bare;
  return new Set([path, bare, name, `${name}.md`]);
}

/** Whether `after` is `before` with only some `[[…]]` targets rewritten as
 * Obsidian rewrites them when a note is renamed: the same links, the same text
 * between them, each one changed naming a renamed note's former path, then its
 * new one, its heading and alias kept. At least one changed. */
export function isRenameRewrite(
  before: string,
  after: string,
  renames: readonly Rename[],
): boolean {
  if (renames.length === 0 || before === after) return false;
  const was = wikilinksIn(before);
  const now = wikilinksIn(after);
  if (was.length !== now.length) return false;
  let atBefore = 0;
  let atAfter = 0;
  let changed = false;
  for (let i = 0; i < was.length; i++) {
    const a = was[i] as WikilinkRange;
    const b = now[i] as WikilinkRange;
    if (before.slice(atBefore, a.from) !== after.slice(atAfter, b.from))
      return false;
    atBefore = a.to;
    atAfter = b.to;
    if (before.slice(a.from, a.to) === after.slice(b.from, b.to)) continue;
    const split = (target: string) => {
      const at = target.indexOf("#");
      return at < 0 ? [target, ""] : [target.slice(0, at), target.slice(at)];
    };
    const [pathA, headingA] = split(a.target);
    const [pathB, headingB] = split(b.target);
    if (a.alias !== b.alias || headingA !== headingB) return false;
    const renamed = renames.some(
      ({ from, to }) =>
        namesOfPath(from).has(pathA as string) &&
        namesOfPath(to).has(pathB as string),
    );
    if (!renamed) return false;
    changed = true;
  }
  return changed && before.slice(atBefore) === after.slice(atAfter);
}
