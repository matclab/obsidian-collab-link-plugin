// What the menu of a link to a heading offers: each
// heading a link can lead to, written for the link's form — `[t](#…)` or
// `[[#…]]` — as Obsidian writes it, its text; what would end or break the
// link left out, punctuation that the match ignores (`headingKey`). A
// second heading of the same text by its parent's path, `Parent#Enfant`.
// Pure.
import { headingForFragment, headingKey } from "./fragment.js";

/** `[t](#…)` or Obsidian's `[[#…]]`. */
export type AnchorForm = "link" | "wikilink";

interface Named {
  source: string;
  text: string;
  level: number;
}

export interface AnchorChoice {
  /** Its index in the outline. */
  heading: number;
  level: number;
  /** What the list shows: the heading as the preview shows it. */
  text: string;
  /** What the link gets after its `#`, written for its form. */
  fragment: string;
}

/** What would end or break the link, in a part of its path: the `#`
 * between parts; in a link, its parentheses and brackets, an angle bracket,
 * an escape, an entity, a `%` taken for an escape, a table's `|`; in a
 * `[[…]]`, its brackets, its alias's `|`, a block's `^`. */
const BREAKS: Record<AnchorForm, RegExp> = {
  link: /[#()[\]<>\\&%|\s]+/g,
  wikilink: /[#[\]|^\s]+/g,
};

const part = (text: string, form: AnchorForm) =>
  text.replace(BREAKS[form], " ").trim().replace(/ +/g, " ");

/** The path to `index`: its own text, then its parent's before it, and so
 * on, the first that leads to it; undefined when none does. */
function pathTo(
  headings: readonly Named[],
  index: number,
  form: AnchorForm,
): string[] | undefined {
  const written = ({ source, text }: Named) =>
    part(source, form) || part(text, form);
  const parts: string[] = [];
  let level = 7;
  for (let i = index; i >= 0; i--) {
    const heading = headings[i] as Named;
    if (heading.level >= level) continue;
    level = heading.level;
    const each = written(heading);
    if (each === "") return undefined;
    parts.unshift(each);
    if (headingForFragment(headings, parts.join("#")) === index) return parts;
  }
  return undefined;
}

/** What a link of `form` can lead to among `headings`, in their order. */
export function anchorChoices(
  headings: readonly Named[],
  form: AnchorForm,
): AnchorChoice[] {
  const choices: AnchorChoice[] = [];
  headings.forEach((heading, index) => {
    const path = pathTo(headings, index, form);
    if (!path) return;
    const decoded = path.join("#");
    choices.push({
      heading: index,
      level: heading.level,
      text: heading.text,
      fragment: form === "link" ? decoded.replace(/ /g, "%20") : decoded,
    });
  });
  return choices;
}

const fold = (text: string) =>
  headingKey(text).normalize("NFD").replace(/\p{M}/gu, "");

/** `query` decoded, as written if it is no escape. */
function decoded(query: string): string {
  try {
    return decodeURIComponent(query);
  } catch {
    return query;
  }
}

/** The choices whose text holds `query`: case, accents and punctuation
 * aside, `%20` a space. */
export function anchorMatches(
  choices: readonly AnchorChoice[],
  query: string,
): readonly AnchorChoice[] {
  const wanted = fold(decoded(query));
  if (wanted === "") return choices;
  return choices.filter((choice) => fold(choice.text).includes(wanted));
}
