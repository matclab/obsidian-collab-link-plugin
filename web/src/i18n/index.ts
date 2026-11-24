import { type Dictionary, en } from "./en.js";
import { fr } from "./fr.js";

export type { Dictionary } from "./en.js";

/** The page's languages. */
export type Language = "en" | "fr";

const DICTIONARIES: Record<Language, Dictionary> = { en, fr };

/** Where this browser keeps the language chosen in the page. */
export const LANGUAGE_KEY = "obsidian-collab:language";

let language: Language = "en";
let dictionary: Dictionary = en;

/** The texts in the page's language. Read at each use: the language is
 * set once, before anything is shown. */
export function t(): Dictionary {
  return dictionary;
}

export function currentLanguage(): Language {
  return language;
}

/** Sets the language, for what is shown from now on; said on `element`
 * (the page's `<html>`), if given — never on another host's. */
export function setLanguage(next: Language, element?: HTMLElement): void {
  language = next;
  dictionary = DICTIONARIES[next];
  if (element) element.lang = next;
}

/** The language chosen in this browser, else the first of the browser's
 * own preferences that the page speaks, else English. */
export function chooseLanguage(
  stored: string | null | undefined,
  preferred: readonly string[],
): Language {
  if (stored === "en" || stored === "fr") return stored;
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "en" || primary === "fr") return primary;
  }
  return "en";
}

/** A date and time as the page's language writes them. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(language);
}

/** A date and time, short (a reply's, ADR-0035), as the page's language
 * writes them: absolute, so it never goes stale on a card not redrawn. */
export function formatShortDate(ms: number): string {
  // One formatter per language: building one costs more than formatting,
  // and a thread's dates are written out at every rendering of its card.
  let format = shortDates.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language, {
      dateStyle: "short",
      timeStyle: "short",
    });
    shortDates.set(language, format);
  }
  return format.format(ms);
}
const shortDates = new Map<string, Intl.DateTimeFormat>();

/** For the pseudo-language test only: shows `next` as is. */
export function useDictionary(next: Dictionary): void {
  dictionary = next;
}
