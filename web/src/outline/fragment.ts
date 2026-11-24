// A link to a heading, `[t](#x)` (docs/phase-19-liens.md, decision 8;
// ADR-0045 §1): the first heading whose text matches `x` as Obsidian
// matches it, ignoring case and punctuation (*Relevé 19.0*); else the
// heading whose GitHub-style id is `x`, what a page's user may write.
// Pure; the preview tries an exact id (its footnotes) before this.

interface Named {
  /** The raw text (`OutlineHeading.source`). */
  source: string;
  /** What the preview shows of it (`OutlineHeading.text`). */
  text: string;
  /** 1 to 6; a path's parts are looked for in their parent's section. */
  level?: number;
}

/** What Obsidian leaves out when it matches a heading. */
const PUNCTUATION = /[!"#$%&()*+,.:;<=>?@^`{|}~/\\[\]]/g;

/** A heading's text, or a fragment, as compared: its punctuation and runs
 * of white space one space, lower case. */
export function headingKey(text: string): string {
  return text
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** One GitHub-style id (github-slugger): lower case, without what is
 * neither a letter, a mark, a digit, `_`, `-` nor a space; spaces `-`. */
function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The ids GitHub gives headings of these texts, in order: a second one
 * of the same id numbered `-1`, then `-2`, never one already given. */
export function githubSlugs(texts: readonly string[]): string[] {
  const given = new Map<string, number>();
  return texts.map((text) => {
    const base = githubSlug(text);
    let slug = base;
    while (given.has(slug)) {
      const count = (given.get(base) ?? 0) + 1;
      given.set(base, count);
      slug = `${base}-${count}`;
    }
    given.set(slug, 0);
    return slug;
  });
}

/** The first heading in `[from, to)` whose raw text is `key`, else the
 * first whose shown text is: `__init__`, shown `init`, doesn't hide a later
 * `init`, which Obsidian, matching the raw text, leads to. */
function firstNamed(
  headings: readonly Named[],
  key: string,
  from = 0,
  to = headings.length,
): number {
  for (const field of ["source", "text"] as const) {
    for (let i = from; i < to; i++) {
      if (headingKey((headings[i] as Named)[field]) === key) return i;
    }
  }
  return -1;
}

/** The heading a path leads to, `Parent#Enfant` (Obsidian's
 * `[[#Parent#Enfant]]`): each part's first heading after the previous
 * part's, before the end of its section. */
function headingForPath(
  headings: readonly Named[],
  parts: readonly string[],
): number | undefined {
  let at = -1;
  let end = headings.length;
  for (const part of parts) {
    const key = headingKey(part);
    if (key === "") return undefined;
    const found = firstNamed(headings, key, at + 1, end);
    if (found < 0) return undefined;
    at = found;
    const level = (headings[found] as Named).level ?? 1;
    end = headings.findIndex(
      (heading, i) => i > found && (heading.level ?? 1) <= level,
    );
    if (end < 0) end = headings.length;
  }
  return at;
}

/** The heading `fragment` (decoded, without its `#`) leads to, if any; a
 * fragment with a `#` in it, by its path first. */
export function headingForFragment(
  headings: readonly Named[],
  fragment: string,
): number | undefined {
  if (fragment.includes("#")) {
    const byPath = headingForPath(headings, fragment.split("#"));
    if (byPath !== undefined) return byPath;
  }
  const key = headingKey(fragment);
  if (key === "") return undefined;
  const byText = firstNamed(headings, key);
  if (byText >= 0) return byText;
  const byId = githubSlugs(headings.map(({ text }) => text)).indexOf(fragment);
  return byId >= 0 ? byId : undefined;
}
