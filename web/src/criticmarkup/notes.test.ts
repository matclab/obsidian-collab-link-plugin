// The notes of an export (ADR-0034 §2): one footnote per annotation, a
// suite of entries — the annotation, then its replies (ADR-0035 §6).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  type NoteEntry,
  extractNotes,
  formatNote,
  formatNoteDate,
  opensEntry,
  parseNoteDate,
} from "./notes.js";

const at = (iso: string) => Date.parse(iso);

describe("a note's date (RFC 3339, to the minute, with an offset)", () => {
  test("is read with its offset: the same instant in any time zone", () => {
    expect(parseNoteDate("2026-10-13 14:02+02:00")).toBe(
      at("2026-10-13T12:02:00Z"),
    );
    expect(parseNoteDate("2026-10-13 14:02Z")).toBe(at("2026-10-13T14:02:00Z"));
    expect(parseNoteDate("2026-10-13T14:02:59-05:30")).toBe(
      at("2026-10-13T19:32:59Z"),
    );
  });

  test("is written to the minute, and read back as that minute", () => {
    const ms = at("2026-10-13T12:02:41.500Z");
    const written = formatNoteDate(ms);
    expect(written).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    );
    expect(parseNoteDate(written)).toBe(at("2026-10-13T12:02:00Z"));
  });

  test("anything else is no date", () => {
    for (const text of [
      "",
      "2026-10-13",
      "13/10/2026 14:02",
      "2026-13-45 99:99Z",
    ]) {
      expect(parseNoteDate(text)).toBeUndefined();
    }
  });
});

describe("writing a note", () => {
  const date = at("2026-10-13T12:02:00Z");
  const when = formatNoteDate(date);

  test("its first entry on the definition's line, the others indented, each line of a text too", () => {
    expect(
      formatNote("cm-1", [
        {
          author: "Alice",
          createdAt: date,
          text: "Faut-il le citer ?\nPlus tôt.",
        },
        { author: "Bob", createdAt: date, text: "Oui." },
      ]),
    ).toBe(
      `[^cm-1]: **Alice** ${when} — Faut-il le citer ?\n    Plus tôt.\n    **Bob** ${when} — Oui.`,
    );
  });

  test("an empty text: no separator; a blank line stays blank", () => {
    expect(
      formatNote("sg-2", [{ author: "Claire", createdAt: date, text: "" }]),
    ).toBe(`[^sg-2]: **Claire** ${when}`);
    expect(
      formatNote("cm-1", [
        { author: "A", createdAt: date, text: "one\n\ntwo" },
      ]),
    ).toBe(`[^cm-1]: **A** ${when} — one\n\n    two`);
  });
});

describe("reading the notes of a file", () => {
  const date = at("2026-10-13T12:02:00Z");
  const when = formatNoteDate(date);

  test("takes them out of the text, separator included, and reads their entries", () => {
    const markdown = `Le {==passage==}[^cm-1] continue.\n\n[^cm-1]: **Alice** ${when} — Pourquoi ?\n    **Bob** ${when} — Parce que.\n`;
    const { body, notes } = extractNotes(markdown);
    expect(body).toBe("Le {==passage==}[^cm-1] continue.");
    expect(notes.get("cm-1")).toEqual([
      { author: "Alice", createdAt: date, text: "Pourquoi ?" },
      { author: "Bob", createdAt: date, text: "Parce que." },
    ]);
  });

  test("a text that ends with a newline keeps it", () => {
    const { body } = extractNotes(`a\n\n\n[^sg-1]: **A** ${when}\n`);
    expect(body).toBe("a\n");
  });

  test("by hand: no date, another separator, no author, a tab", () => {
    const { notes } = extractNotes(
      [
        "x",
        "",
        "[^cm-1]: **Alice**: sans date",
        "\t**Bob** — sans date non plus",
        "[^cm-2]: rien que du texte",
        "    sur deux lignes",
      ].join("\n"),
    );
    expect(notes.get("cm-1")).toEqual([
      { author: "Alice", text: "sans date" },
      { author: "Bob", text: "sans date non plus" },
    ]);
    expect(notes.get("cm-2")).toEqual([
      { text: "rien que du texte\nsur deux lignes" },
    ]);
  });

  test("a blank line followed by an indented one continues the entry; an unindented line ends the note", () => {
    const { body, notes } = extractNotes(
      `[^cm-1]: **A** ${when} — one\n\n    two\n\nAfter the note.\n`,
    );
    expect(notes.get("cm-1")).toEqual([
      { author: "A", createdAt: date, text: "one\n\ntwo" },
    ]);
    expect(body).toBe("\nAfter the note.\n");
  });

  test("other footnotes are the author's: left in the text", () => {
    const markdown = "a[^1] b[^note]\n\n[^1]: mine\n[^note]: mine too\n";
    expect(extractNotes(markdown)).toEqual({
      body: markdown,
      notes: new Map(),
      duplicates: [],
    });
  });

  test("a name defined twice: the first definition counts, the second is said", () => {
    const { notes, duplicates } = extractNotes(
      "[^cm-1]: **A** — first\n[^cm-1]: **B** — second\n",
    );
    expect(notes.get("cm-1")).toEqual([{ author: "A", text: "first" }]);
    expect(duplicates).toEqual(["cm-1"]);
  });

  test("blanks at the end of a text are not kept; trailing blank lines neither", () => {
    const { notes } = extractNotes(`[^cm-1]: **A** ${when} — text   \n    \n`);
    expect(notes.get("cm-1")).toEqual([
      { author: "A", createdAt: date, text: "text" },
    ]);
  });
});

// ADR-0047 §6: a line opens an entry when an author in bold is followed
// by a date or a separator; a text's line in bold goes on.
describe("which line of a note opens an entry", () => {
  const when = formatNoteDate(at("2026-10-30T09:00:00Z"));

  test("an author, then a date, `—` or `:`", () => {
    for (const line of [
      `**Bob** ${when}`,
      `**Bob** ${when} — oui`,
      "**Bob** 2026-10-30 10:00+01:00",
      "**Bob** — oui",
      "**Bob** : oui",
      "**Bob**: oui",
      "**Bob**  —",
    ]) {
      expect(opensEntry(line), line).toBe(true);
    }
  });

  test("bold then anything else goes on", () => {
    for (const line of [
      "**Non**, parce que…",
      "**Important** dans ce cas",
      "**Bob** oui",
      "**Bob**",
      "**a** **b** — c",
      "**Bob** 2026-13-30 10:00+01:00",
      "**unclosed — x",
      " **Bob** — oui",
      "- **Bob** — oui",
    ]) {
      expect(opensEntry(line), line).toBe(false);
    }
  });

  test("a text's line in bold stays in its entry; an author without date nor separator too, the loss ADR-0047 admits", () => {
    const { notes } = extractNotes(
      [
        "[^cm-1]: **Alice** — Voir :",
        "    **Non**, parce que…",
        "    **Important** dans ce cas.",
        "    **Bob** oui",
        "    **Carol** : d'accord",
      ].join("\n"),
    );
    expect(notes.get("cm-1")).toEqual([
      {
        author: "Alice",
        text: "Voir :\n**Non**, parce que…\n**Important** dans ce cas.\n**Bob** oui",
      },
      { author: "Carol", text: "d'accord" },
    ]);
  });
});

// A note alone, written then read: what ADR-0034 promises survives —
// the authors, the dates to the minute, the texts, but blanks at the end
// of a line, and a line that opens an entry (ADR-0047 §6).
const PSEUDONYM = { minSize: 1, maxSize: 8, alphabet: "abcé Z-_" };
const TEXT = { minSize: 0, maxSize: 30, alphabet: "ab *:—\n\t[]^-" };

describe("a note alone (property)", () => {
  test("written then read, gives its entries back", () =>
    hegel.test(
      (tc) => {
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const entries: Required<NoteEntry>[] = [];
        for (let i = 0; i < count; i++) {
          const author = tc.draw(gs.text(PSEUDONYM)).trim();
          const text = tc
            .draw(gs.text(TEXT))
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => !opensEntry(line.trimStart()))
            .join("\n")
            .replace(/^\s+|\s+$/g, "");
          const minute = tc.draw(
            gs.integers({ minValue: 0, maxValue: 60_000_000 }),
          );
          if (author === "" || author.includes("*")) continue;
          entries.push({ author, createdAt: minute * 60_000, text });
        }
        if (entries.length === 0) return;
        const name = tc.draw(gs.sampledFrom(["cm-1", "sg-12"]));
        const { body, notes } = extractNotes(
          `x\n\n${formatNote(name, entries)}\n`,
        );
        expect(body).toBe("x");
        expect(notes.get(name)).toEqual(entries);
      },
      { testCases: 300 },
    ));

  test("any file: no exception, every name a cm or sg name, every entry well formed", () =>
    hegel.test(
      (tc) => {
        const lines = tc.draw(
          gs.arrays(
            gs.oneOf(
              gs.sampledFrom([
                "[^cm-1]: **A** 2026-10-13 14:02+02:00 — t",
                "[^sg-2]:",
                "[^cm-1]:**",
                "[^1]: x",
                "    **B** —",
                "\t**",
                "    ** **",
                "**A**",
                "",
                "    ",
                "[^cm-01]: x",
                "[^cm-]: x",
              ]),
              gs.text({ maxSize: 12, alphabet: "[]^cmsg-0123: *\t—Z+" }),
            ),
            { maxSize: 12 },
          ),
        );
        const markdown = lines.join(tc.draw(gs.sampledFrom(["\n", "\r\n"])));
        const { body, notes, duplicates } = extractNotes(markdown);
        expect(typeof body).toBe("string");
        expect(body.length).toBeLessThanOrEqual(markdown.length);
        for (const [name, entries] of notes) {
          expect(name).toMatch(/^(cm|sg)-[1-9][0-9]*$/);
          for (const entry of entries) {
            expect(typeof entry.text).toBe("string");
            if (entry.author !== undefined) expect(entry.author).not.toBe("");
            if (entry.createdAt !== undefined)
              expect(Number.isFinite(entry.createdAt)).toBe(true);
          }
        }
        for (const name of duplicates) expect(notes.has(name)).toBe(true);
      },
      { testCases: 500 },
    ));
});
