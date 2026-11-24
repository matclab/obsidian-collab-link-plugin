// Moving a section (docs/phase-17-editeur-natif-obsidian.md, decision 7):
// a heading with what follows it up to the next heading of its level or
// above, before the previous section of its level or after the next one,
// never out of its parent. Pure: the changes, for the editor to apply in
// one transaction, which the link to Loro turns into operations as it does
// a keystroke. Only the moved section is cut and inserted again: the text
// around, its neighbour included, is left as it is (an edit of another's
// still on its way lands there); one in the moved section, not received
// yet, stays at the old place (decision 7, its limit). The blank lines
// between two sections stay where they are: moved up, the
// section cuts the gap above it and writes a copy after itself, blank
// lines only. A move that would
// change what the text means — a setext heading after a paragraph, which
// it would continue; a code block left open, which would take what
// follows — is refused: the headings read again must be the same.
import { type OutlineHeading, outlineOfText } from "./outline.js";

export type Direction = "up" | "down";

export interface SectionMove {
  /** Positions in the text before, as CodeMirror's `changes`. */
  changes: { from: number; to?: number; insert: string }[];
  /** Where the moved heading starts once applied. */
  headingAt: number;
}

/** Where the section of heading `index` ends: the next heading of its
 * level or above, else the text's end. */
function sectionEnd(
  headings: readonly OutlineHeading[],
  index: number,
  length: number,
): number {
  const level = headings[index]?.level ?? 0;
  for (let next = index + 1; next < headings.length; next++) {
    const heading = headings[next] as OutlineHeading;
    if (heading.level <= level) return heading.from;
  }
  return length;
}

/** The section the caret at `pos` is in moved one place `direction`, or
 * nothing: before the first heading, or no section of its level there in
 * its parent. `headings` are `text`'s (`outlineOfText`, the outline's). */
export function moveSection(
  text: string,
  headings: readonly OutlineHeading[],
  pos: number,
  direction: Direction,
): SectionMove | undefined {
  const move = proposedMove(text, headings, pos, direction);
  if (!move) return undefined;
  return same(outlineOfText(applied(text, move)), headings) ? move : undefined;
}

/** The text with `move` applied. */
export function applied(text: string, move: SectionMove): string {
  let result = text;
  for (const change of [...move.changes].sort((a, b) => b.from - a.from)) {
    result =
      result.slice(0, change.from) +
      change.insert +
      result.slice(change.to ?? change.from);
  }
  return result;
}

const key = (headings: readonly OutlineHeading[]) =>
  headings
    .map((heading) => `${heading.level} ${heading.source}`)
    .sort()
    .join("\n");
const same = (a: readonly OutlineHeading[], b: readonly OutlineHeading[]) =>
  a.length === b.length && key(a) === key(b);

function proposedMove(
  text: string,
  headings: readonly OutlineHeading[],
  pos: number,
  direction: Direction,
): SectionMove | undefined {
  let index = -1;
  for (let at = 0; at < headings.length; at++) {
    if ((headings[at] as OutlineHeading).from <= pos) index = at;
    else break;
  }
  const heading = headings[index];
  if (!heading) return undefined;
  // A final line break ends the text, it is no line of the last section:
  // it stays at the end.
  const length = text.endsWith("\n") ? text.length - 1 : text.length;
  const from = heading.from;
  const to = sectionEnd(headings, index, length);

  if (direction === "up") {
    let previous = index - 1;
    while (previous >= 0 && (headings[previous]?.level ?? 0) > heading.level)
      previous--;
    const sibling = headings[previous];
    if (!sibling || sibling.level !== heading.level) return undefined;
    const [, gap] = split(text.slice(sibling.from, from));
    const [content] = split(text.slice(from, to));
    // The sibling's gap goes before it, a copy; the section's own stays.
    return {
      changes: [
        { from: sibling.from, insert: content + gap },
        { from: from - gap.length, to: from + content.length, insert: "" },
      ],
      headingAt: sibling.from,
    };
  }

  let next = index + 1;
  while (next < headings.length && (headings[next]?.level ?? 0) > heading.level)
    next++;
  const sibling = headings[next];
  if (!sibling || sibling.level !== heading.level) return undefined;
  const end = sectionEnd(headings, next, length);
  const [content, gap] = split(text.slice(from, to));
  const [above] = split(text.slice(to, end));
  // After the sibling's text, before its gap, which stays.
  return {
    changes: [
      { from, to, insert: "" },
      { from: to + above.length, insert: gap + content },
    ],
    headingAt: from + above.length + gap.length,
  };
}

/** A section's text, and what ends it: the line break after its last
 * line, and the blank lines after (none for the last section, its final
 * line break left out). The gap between two sections stays where it is,
 * whichever section comes before it. */
function split(section: string): [string, string] {
  const gap = /\n(?:[ \t]*\n)*$/.exec(section)?.[0] ?? "";
  return [section.slice(0, section.length - gap.length), gap];
}
