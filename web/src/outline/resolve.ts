// Finding a heading asked for (docs/phase-16-plan-du-document.md,
// decision 8), by the page's outline or by Obsidian's: not by its rank,
// which a heading added or removed elsewhere shifts, nor by its line,
// which a late export shifts.

/** A heading asked for: its raw text (`OutlineHeading.source`, or the
 * `heading` of Obsidian's metadataCache), its level, and its rank among
 * the headings of that text at that level, counted by who asks. */
export interface HeadingTarget {
  source: string;
  level: number;
  occurrence: number;
}

interface Named {
  source: string;
  level: number;
}

/** The target that names `headings[index]`. */
export function targetOf(
  headings: readonly Named[],
  index: number,
): HeadingTarget {
  const { source, level } = headings[index] as Named;
  let occurrence = 0;
  for (let i = 0; i < index; i++) {
    const other = headings[i] as Named;
    if (other.source === source && other.level === level) occurrence++;
  }
  return { source, level, occurrence };
}

/** Where `target` is in `headings`: the same occurrence of its text at
 * its level; else the last of its text at its level; else the first of
 * its text; else none. */
export function resolveHeading(
  headings: readonly Named[],
  target: HeadingTarget,
): number | undefined {
  let last: number | undefined;
  let seen = 0;
  let anyLevel: number | undefined;
  for (let i = 0; i < headings.length; i++) {
    const { source, level } = headings[i] as Named;
    if (source !== target.source) continue;
    anyLevel ??= i;
    if (level !== target.level) continue;
    if (seen === target.occurrence) return i;
    seen++;
    last = i;
  }
  return last ?? anyLevel;
}
