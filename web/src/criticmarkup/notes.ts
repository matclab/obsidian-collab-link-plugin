/** The notes of an export (ADR-0034 §2): one Markdown footnote per
 * annotation, `[^cm-N]` for a comment, `[^sg-N]` for a suggestion, at the
 * end of the file. A note is a suite of entries — the annotation's own
 * (author, date, its text), then its replies (ADR-0035 §6). Pure: text in,
 * text out; what the names refer to is `parse.ts`'s business. */

/** One entry of a note: what a file holds, read tolerantly — written by
 * hand, it may have no author or no date. */
export interface NoteEntry {
  author?: string;
  /** Milliseconds since the epoch; written to the minute. */
  createdAt?: number;
  text: string;
}

/** A name of ours: `cm-N` or `sg-N`, N from 1, without leading zero. */
const NAME = /^(?:cm|sg)-[1-9][0-9]*$/;
const DEFINITION = /^\[\^((?:cm|sg)-[0-9]+)\]:[ \t]?(.*)$/;
const DATE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})/;
/** An entry starts with its author in bold, at the start of a line. */
const AUTHOR = /^\*\*(.+?)\*\*/;
/** The separator after an author or its date: ` — `, `:`, or none. */
const SEPARATOR = /^\s*(?:—|:)?\s*/;

export function isNoteName(name: string): boolean {
  return NAME.test(name);
}

const two = (n: number) => String(n).padStart(2, "0");

/** RFC 3339 to the minute, in this page's time zone, with its offset:
 * `2026-10-13 14:02+02:00` — the same instant once read anywhere. */
export function formatNoteDate(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}${sign}${two(hours)}:${two(minutes)}`;
}

/** A date at the start of `text` as `formatNoteDate` writes it (a `T`,
 * seconds and `Z` accepted too), and how long it is; `undefined` if
 * there is none. */
function readDate(text: string): { ms: number; length: number } | undefined {
  const match = DATE.exec(text);
  if (!match) return undefined;
  const [all, y, mo, d, h, mi, s, zone] = match;
  const [year, month, day, hour, minute, second] = [
    y,
    mo,
    d,
    h,
    mi,
    s ?? "0",
  ].map(Number) as [number, number, number, number, number, number];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  let offset = 0;
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  const ms =
    Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000;
  return Number.isFinite(ms) ? { ms, length: all.length } : undefined;
}

/** A whole date, or `undefined`. */
export function parseNoteDate(text: string): number | undefined {
  const read = readDate(text);
  return read && read.length === text.length ? read.ms : undefined;
}

/** `[^name]: **author** date — text`, each further line of a text, and
 * each further entry, indented by four spaces (a footnote's
 * continuation); a blank line stays blank. No separator after an empty
 * text. */
export function formatNote(
  name: string,
  entries: readonly Required<NoteEntry>[],
): string {
  const lines: string[] = [];
  for (const { author, createdAt, text } of entries) {
    const [first = "", ...rest] = text.split("\n");
    const head = `**${author}** ${formatNoteDate(createdAt)}`;
    lines.push(first === "" ? head : `${head} — ${first}`);
    lines.push(...rest);
  }
  return lines
    .map((line, i) =>
      i === 0 ? `[^${name}]: ${line}` : line === "" ? "" : `    ${line}`,
    )
    .join("\n");
}

/** One line of a note, de-indented: a new entry if it starts with an
 * author in bold followed by a date or a separator (ADR-0047 §6), else
 * more of the entry in progress — a text's line in bold (`**Non**, parce
 * que…`) included. */
function readEntryLine(line: string): NoteEntry | undefined {
  const author = AUTHOR.exec(line);
  if (!author?.[1]) return undefined;
  let rest = line.slice(author[0].length).trimStart();
  const entry: NoteEntry = { author: author[1], text: "" };
  const date = readDate(rest);
  if (date) {
    entry.createdAt = date.ms;
    rest = rest.slice(date.length);
  } else if (!/^(?:—|:)/.test(rest)) {
    return undefined;
  }
  entry.text = rest.replace(SEPARATOR, "");
  return entry;
}

/** Whether `line`, de-indented, opens an entry of a note: the import's
 * rule, by which the export says a text would read back otherwise. */
export function opensEntry(line: string): boolean {
  return readEntryLine(line) !== undefined;
}

function readNote(lines: readonly string[]): NoteEntry[] {
  const entries: NoteEntry[] = [];
  const texts: string[][] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const entry = readEntryLine(line);
    if (entry) {
      entries.push(entry);
      texts.push([entry.text]);
    } else if (texts.length === 0) {
      // Written by hand without an author: the importer's.
      entries.push({ text: line.trim() });
      texts.push([line.trim()]);
    } else {
      texts[texts.length - 1]?.push(line);
    }
  }
  return entries.map((entry, i) => ({
    ...entry,
    text: asNoteText((texts[i] ?? []).join("\n")),
  }));
}

/** A text as an entry of a note reads back (ADR-0034, « ce qui ne fait
 * pas l'aller-retour »): no blank before its first line nor at the end of
 * any, no empty line at its end. The import gives this form at once to a
 * text written in the text (`{>>…<<}`), which its export would lose. */
export function asNoteText(text: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line.trim() : line.trimEnd()))
    .join("\n")
    .replace(/\n+$/, "");
}

const indented = (line: string) =>
  line.startsWith("    ") || line.startsWith("\t");
const deindent = (line: string) =>
  line.startsWith("\t") ? line.slice(1) : line.slice(4);
const blank = (line: string) => line.trim() === "";

/** Takes our notes out of `markdown`: the text without them (and without
 * the blank line before notes that end the file), each note's entries by
 * name, and the names defined more than once (the first definition
 * counts). A note is its definition's line, then the lines indented by
 * four spaces or a tab, blank lines followed by one included. Other
 * footnotes are left in the text. */
export function extractNotes(markdown: string): {
  body: string;
  notes: Map<string, NoteEntry[]>;
  duplicates: string[];
} {
  const lines = markdown.split("\n");
  // Where each line starts, the end of the text last.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const startOf = (i: number) =>
    Math.min(starts[i] ?? markdown.length, markdown.length);

  const notes = new Map<string, NoteEntry[]>();
  const duplicates: string[] = [];
  const spans: { from: number; to: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const definition = DEFINITION.exec((lines[i] ?? "").replace(/\r$/, ""));
    const name = definition?.[1];
    if (!definition || name === undefined || !isNoteName(name)) continue;
    const content: string[] = [];
    if (!blank(definition[2] ?? "")) content.push(definition[2] ?? "");
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (indented(line) && !blank(line)) {
        for (let k = last + 1; k < j; k++) content.push("");
        content.push(deindent(line));
        last = j;
      } else if (!blank(line)) {
        break;
      }
    }
    spans.push({ from: startOf(i), to: startOf(last + 1) });
    if (notes.has(name)) duplicates.push(name);
    else notes.set(name, readNote(content));
    i = last;
  }
  if (spans.length === 0) return { body: markdown, notes, duplicates };

  // Notes that end the file, blank lines between them and after: taken
  // with the separator before them (`exportMarkdown` writes "\n\n").
  let trailing = spans.length;
  let end = markdown.length;
  while (trailing > 0) {
    const span = spans[trailing - 1];
    if (!span || !blank(markdown.slice(span.to, end))) break;
    end = span.from;
    trailing--;
  }
  let body = "";
  let cursor = 0;
  for (const span of spans.slice(0, trailing)) {
    body += markdown.slice(cursor, span.from);
    cursor = span.to;
  }
  if (trailing < spans.length) {
    let before = markdown.slice(cursor, end);
    if (before.endsWith("\n\n")) before = before.slice(0, -2);
    else if (before.endsWith("\n")) before = before.slice(0, -1);
    body += before;
  } else {
    body += markdown.slice(cursor);
  }
  return { body, notes, duplicates };
}
