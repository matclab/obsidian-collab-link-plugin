// Obsidian's callouts: the header both parsers read, by the
// rule surveyed in Obsidian 1.13.7's reading mode (*Relevé 15a*).

/** The families of callouts Obsidian knows; an unknown type is a note. */
export type CalloutFamily =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";

const FAMILIES = new Map<string, CalloutFamily>([
  ["note", "note"],
  ["abstract", "abstract"],
  ["summary", "abstract"],
  ["tldr", "abstract"],
  ["info", "info"],
  ["todo", "todo"],
  ["tip", "tip"],
  ["hint", "tip"],
  ["important", "tip"],
  ["success", "success"],
  ["check", "success"],
  ["done", "success"],
  ["question", "question"],
  ["help", "question"],
  ["faq", "question"],
  ["warning", "warning"],
  ["caution", "warning"],
  ["attention", "warning"],
  ["failure", "failure"],
  ["fail", "failure"],
  ["missing", "failure"],
  ["danger", "danger"],
  ["error", "danger"],
  ["bug", "bug"],
  ["example", "example"],
  ["quote", "quote"],
  ["cite", "quote"],
]);

/** The words Obsidian reads as `family`, its own first (ADR-0063, EN2). */
export function calloutWords(family: CalloutFamily): string[] {
  return [...FAMILIES].flatMap(([word, of]) => (of === family ? [word] : []));
}

export interface CalloutHeader {
  /** Trimmed, lowercased, spaces as dashes; any other character kept. */
  type: string;
  family: CalloutFamily;
  /** `-` folded, `+` unfolded, or none: not foldable. */
  fold: "" | "+" | "-";
  /** The rest of the line, trimmed, as Markdown; empty for the default. */
  title: string;
  /** Where the `[` is in the line. */
  at: number;
}

// `[!type]`, a fold sign stuck to it, then the end or a space and the title.
const HEADER = /^\[!([^\]]*)\]([+-]?)(?:[ \t]+(.*))?$/;

/** Where the `]` of a callout's header is in `text`, which starts at its
 * `[` and runs to its line's end at least, or -1: not a header's shape.
 * For the editor's parser, which sees a paragraph's text only (the quote
 * markers before it, the paragraph's place, are `calloutHeader`'s). */
export function calloutShape(text: string): number {
  const newline = text.indexOf("\n");
  const found = HEADER.exec(newline < 0 ? text : text.slice(0, newline));
  const type = found?.[1] ?? "";
  if (!found || (type.split("|")[0] ?? "").trim() === "") return -1;
  return 2 + type.length;
}

/** The callout this quote's first line opens, or null. `line` is the line
 * as written, quote markers included; `at`, where its first paragraph
 * starts (by default, after its leading markers and blanks). Only `>` and
 * at most one space may come right before it. */
export function calloutHeader(
  line: string,
  at = /^[ \t>]*/.exec(line)?.[0].length ?? 0,
): CalloutHeader | null {
  if (!/> ?$/.test(line.slice(0, at))) return null;
  const found = HEADER.exec(line.slice(at));
  if (!found) return null;
  const type = (found[1] ?? "").split("|")[0]?.trim().toLowerCase() ?? "";
  if (type === "") return null;
  const normalized = type.replace(/ /g, "-");
  return {
    type: normalized,
    family: FAMILIES.get(normalized) ?? "note",
    fold: (found[2] ?? "") as CalloutHeader["fold"],
    title: (found[3] ?? "").trim(),
    at,
  };
}

/** Obsidian's title for a callout without one: its type, dashes as
 * spaces, a capital first letter. Text of the document, not translated
 * (decision 5). */
export function defaultCalloutTitle(type: string): string {
  const words = type.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
