import { describe, expect, test } from "vitest";
import {
  type ResolvedAnnotation,
  formatCriticMarkup,
  writeCriticMarkup,
} from "./format.js";
import { extractNotes, formatNoteDate } from "./notes.js";
import { parseCriticMarkup } from "./parse.js";

const base = {
  author: "alice",
  status: "open" as const,
  createdAt: 0,
  replies: [],
};
const d0 = formatNoteDate(0);

/** The text part of an export, its notes taken out. */
const text = (markdown: string) => extractNotes(markdown).body;

describe("formatCriticMarkup: the marks and references (ADR-0034 §1)", () => {
  test("writes an addition's proposed text at its insertion point (ADR-0018), then its reference", () => {
    const output = formatCriticMarkup("hello world", [
      {
        ...base,
        id: "a1",
        type: "addition",
        range: { start: 5, end: 5 },
        proposed: " dear",
      },
    ]);
    expect(output).toBe(
      `hello{++ dear++}[^sg-1] world\n\n[^sg-1]: **alice** ${d0}\n`,
    );
  });

  test("wraps a deletion annotation's range with {--...--}", () => {
    const output = formatCriticMarkup("hello world", [
      { ...base, id: "a1", type: "deletion", range: { start: 0, end: 5 } },
    ]);
    expect(text(output)).toBe("{--hello--}[^sg-1] world");
  });

  test("wraps a substitution's old text, with its proposed text after the arrow", () => {
    const output = formatCriticMarkup("hello world", [
      {
        ...base,
        id: "a1",
        type: "substitution",
        range: { start: 0, end: 5 },
        proposed: "goodbye",
      },
    ]);
    expect(text(output)).toBe("{~~hello~>goodbye~~}[^sg-1] world");
  });

  test.each(["addition", "substitution"] as const)(
    "leaves out an open %s without a proposed text (its change pending or invalid)",
    (type) => {
      const output = formatCriticMarkup("hello world", [
        {
          ...base,
          id: "a1",
          type,
          range: { start: 0, end: type === "addition" ? 0 : 5 },
        },
      ]);
      expect(output).toBe("hello world");
    },
  );

  test.each([
    ["addition", { start: 5, end: 5 }, "hello{++ dear++}[^sg-1] world"],
    ["deletion", { start: 0, end: 5 }, "{--hello--}[^sg-1] world"],
    ["substitution", { start: 0, end: 5 }, "{~~hello~> dear~~}[^sg-1] world"],
  ] as const)(
    "writes a %s's note in its footnote, no longer as a comment after it",
    (type, range, expected) => {
      const output = formatCriticMarkup("hello world", [
        {
          ...base,
          id: "a1",
          type,
          range,
          note: "warmer",
          ...(type !== "deletion" && { proposed: " dear" }),
        },
      ]);
      expect(output).toBe(`${expected}\n\n[^sg-1]: **alice** ${d0} — warmer\n`);
    },
  );

  test("writes a comment over its range, in a highlight, its text as is", () => {
    const output = formatCriticMarkup("hello world", [
      {
        ...base,
        id: "a1",
        type: "comment",
        range: { start: 0, end: 5 },
        body: "needs work",
      },
    ]);
    expect(output).toBe(
      `{==hello==}[^cm-1] world\n\n[^cm-1]: **alice** ${d0} — needs work\n`,
    );
  });

  test("writes a comment on an empty range as its reference alone", () => {
    const output = formatCriticMarkup("one two", [
      {
        ...base,
        id: "c",
        type: "comment",
        range: { start: 3, end: 3 },
        body: "c",
      },
    ]);
    expect(text(output)).toBe("one[^cm-1] two");
  });

  test("renders a nested annotation inside its parent's markers", () => {
    const output = formatCriticMarkup("hello world", [
      { ...base, id: "outer", type: "deletion", range: { start: 0, end: 11 } },
      {
        ...base,
        id: "inner",
        type: "comment",
        author: "bob",
        range: { start: 6, end: 11 },
        body: "nice",
      },
    ]);
    expect(text(output)).toBe("{--hello {==world==}[^cm-1]--}[^sg-1]");
  });

  test("a comment's highlight holds the suggestions in its range", () => {
    const output = formatCriticMarkup("hello world", [
      {
        ...base,
        id: "c",
        type: "comment",
        range: { start: 0, end: 11 },
        body: "x",
      },
      { ...base, id: "d", type: "deletion", range: { start: 6, end: 11 } },
    ]);
    expect(text(output)).toBe("{==hello {--world--}[^sg-1]==}[^cm-1]");
  });

  test("refuses to export when two suggestions cross (ADR-0012 layer 3)", () => {
    expect(() =>
      formatCriticMarkup("hello world", [
        { ...base, id: "a1", type: "deletion", range: { start: 0, end: 7 } },
        { ...base, id: "a2", type: "deletion", range: { start: 5, end: 11 } },
      ]),
    ).toThrow(/a1.*a2|a2.*a1/);
  });

  test("skips a closed annotation entirely on export, even if its range would otherwise cross another", () => {
    const output = formatCriticMarkup("hello world", [
      {
        ...base,
        id: "a1",
        type: "comment",
        status: "resolved",
        range: { start: 0, end: 7 },
        body: "x",
      },
      {
        ...base,
        id: "a2",
        type: "deletion",
        author: "bob",
        range: { start: 5, end: 11 },
      },
    ]);
    expect(output).toBe(`hello{-- world--}[^sg-1]\n\n[^sg-1]: **bob** ${d0}\n`);
  });

  test("does not throw when annotations are only disjoint or nested", () => {
    expect(() =>
      formatCriticMarkup("hello world", [
        {
          ...base,
          id: "a1",
          type: "comment",
          range: { start: 0, end: 5 },
          body: "x",
        },
        {
          ...base,
          id: "a2",
          type: "comment",
          range: { start: 6, end: 11 },
          body: "y",
        },
      ]),
    ).not.toThrow();
  });

  test.each([
    ["at its start", 0, "{++x++}[^sg-1]{~~ab~>w~~}[^sg-2]c"],
    ["at its end", 2, "{~~ab~>w~~}[^sg-1]{++x++}[^sg-2]c"],
  ])(
    "writes an addition %s outside a substitution, which holds no marker",
    (_, at, expected) => {
      expect(
        text(
          formatCriticMarkup("abc", [
            {
              ...base,
              id: "s",
              type: "substitution",
              range: { start: 0, end: 2 },
              proposed: "w",
            },
            {
              ...base,
              id: "a",
              type: "addition",
              range: { start: at, end: at },
              proposed: "x",
            },
          ]),
        ),
      ).toBe(expected);
    },
  );

  test("a comment at the end of a substitution comes after it: its reference names it, nothing reads it as a note", () => {
    expect(
      text(
        formatCriticMarkup("abc", [
          {
            ...base,
            id: "s",
            type: "substitution",
            range: { start: 0, end: 2 },
            proposed: "w",
          },
          {
            ...base,
            id: "c",
            type: "comment",
            range: { start: 2, end: 2 },
            body: "why",
          },
        ]),
      ),
    ).toBe("{~~ab~>w~~}[^sg-1][^cm-1]c");
  });

  test("a comment and an addition at the same point: each its own reference", () => {
    expect(
      text(
        formatCriticMarkup("ab", [
          {
            ...base,
            id: "1",
            type: "addition",
            range: { start: 1, end: 1 },
            proposed: "x",
          },
          {
            ...base,
            id: "2",
            type: "comment",
            range: { start: 1, end: 1 },
            body: "c",
          },
        ]),
      ),
    ).toBe("a[^cm-1]{++x++}[^sg-1]b");
  });

  test("comments over a suggestion and over the same range: highlights nested, the substitution innermost", () => {
    expect(
      text(
        formatCriticMarkup("one two", [
          {
            ...base,
            id: "s",
            type: "substitution",
            range: { start: 4, end: 7 },
            proposed: "2",
          },
          {
            ...base,
            id: "c",
            type: "comment",
            range: { start: 0, end: 7 },
            body: "all",
          },
          {
            ...base,
            id: "d",
            type: "comment",
            range: { start: 4, end: 7 },
            body: "this",
          },
        ]),
      ),
    ).toBe("{==one {=={~~two~>2~~}[^sg-1]==}[^cm-1]==}[^cm-2]");
  });

  test("nests suggestions on the same range one inside the other, the text written once", () => {
    const deletion = (id: string) => ({
      ...base,
      id,
      type: "deletion" as const,
      range: { start: 0, end: 1 },
    });
    expect(
      text(
        formatCriticMarkup("one", [
          deletion("a"),
          deletion("b"),
          deletion("c"),
        ]),
      ),
    ).toBe("{--{--{--o--}[^sg-1]--}[^sg-2]--}[^sg-3]ne");
  });
});

describe("a comment that would cross goes back to a point (ADR-0034 §4)", () => {
  test("crossing a suggestion: its reference at the end of its range, what it covered at the head of its text", () => {
    const { markdown, pointed } = writeCriticMarkup("one two three", [
      { ...base, id: "d", type: "deletion", range: { start: 4, end: 13 } },
      {
        ...base,
        id: "c",
        type: "comment",
        range: { start: 0, end: 7 },
        body: "x",
      },
    ]);
    expect(pointed).toBe(1);
    expect(markdown).toBe(
      `one {--two[^cm-1] three--}[^sg-1]\n\n[^cm-1]: **alice** ${d0} — one … two — x\n\n[^sg-1]: **alice** ${d0}\n`,
    );
  });

  test("crossing an earlier comment: the later one goes back to a point", () => {
    const { markdown, pointed } = writeCriticMarkup("hello world", [
      {
        ...base,
        id: "a1",
        type: "comment",
        range: { start: 0, end: 7 },
        body: "x",
      },
      {
        ...base,
        id: "a2",
        type: "comment",
        range: { start: 5, end: 11 },
        body: "y",
      },
    ]);
    expect(pointed).toBe(1);
    expect(text(markdown)).toBe("{==hello w==}[^cm-1]orld[^cm-2]");
    expect(extractNotes(markdown).notes.get("cm-2")?.[0]?.text).toBe(
      "world — y",
    );
  });

  test("one word, several words: what it covers", () => {
    const covered = (start: number, end: number) =>
      extractNotes(
        writeCriticMarkup("one two three", [
          { ...base, id: "d", type: "deletion", range: { start: 2, end: 9 } },
          {
            ...base,
            id: "c",
            type: "comment",
            range: { start, end },
            body: "c",
          },
        ]).markdown,
      ).notes.get("cm-1")?.[0]?.text;
    expect(covered(0, 3)).toBe("one — c");
    expect(covered(4, 13)).toBe("two … three — c");
  });
});

describe("the notes (ADR-0034 §2, ADR-0035 §6)", () => {
  test("comments' first, then suggestions', each in the text's order: the annotation's entry, then its replies", () => {
    const at = Date.parse("2026-10-13T12:02:00Z");
    const later = Date.parse("2026-10-14T07:10:00Z");
    const annotations: ResolvedAnnotation[] = [
      {
        ...base,
        id: "d",
        type: "deletion",
        author: "Claire",
        createdAt: later,
        range: { start: 11, end: 14 },
        note: "Redondant.",
      },
      {
        ...base,
        id: "c",
        type: "comment",
        author: "Alice",
        createdAt: at,
        range: { start: 0, end: 3 },
        body: "Faut-il le citer ?\nPlus tôt.",
        replies: [{ author: "Bob", createdAt: later, body: "Oui." }],
      },
    ];
    expect(formatCriticMarkup("Le passage mot.", annotations)).toBe(
      [
        "{==Le ==}[^cm-1]passage {--mot--}[^sg-1].",
        "",
        `[^cm-1]: **Alice** ${formatNoteDate(at)} — Faut-il le citer ?`,
        "    Plus tôt.",
        `    **Bob** ${formatNoteDate(later)} — Oui.`,
        "",
        `[^sg-1]: **Claire** ${formatNoteDate(later)} — Redondant.`,
        "",
      ].join("\n"),
    );
  });

  test("no annotation: the text alone, no separator", () => {
    expect(formatCriticMarkup("text\n", [])).toBe("text\n");
  });
});

// ADR-0044: Obsidian's highlights are text to CriticMarkup (`==b==`
// without braces); a comment's own highlight `{==…==}` around or inside
// one reads back as written.
describe("formatCriticMarkup: a text with highlights", () => {
  test("a comment around, inside or beside a highlight round-trips", () => {
    const source = "a ==🔴b== c ==d== e";
    for (const range of [
      { start: 2, end: 9 },
      { start: 6, end: 7 },
      { start: 10, end: 11 },
      { start: 12, end: 17 },
      { start: 0, end: source.length },
    ]) {
      const markdown = formatCriticMarkup(source, [
        { ...base, id: "c1", type: "comment", range, body: "?" },
      ]);
      const read = parseCriticMarkup(markdown);
      expect(read.text, markdown).toBe(source);
      expect(
        read.annotations.map(({ start, end }) => ({ start, end })),
        markdown,
      ).toEqual([range]);
    }
  });
});
