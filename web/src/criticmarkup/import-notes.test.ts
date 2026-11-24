// Importing an export that another tool may have changed (ADR-0034 §5,
// ADR-0035 §6): everything is attached by name, nothing is lost without a
// word. One test per line of the ADR's table.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  listAnnotations,
  suggestAddition,
} from "../../lib/src/annotations/index.js";
import { importMarkdown } from "./import.js";
import { formatNoteDate } from "./notes.js";

const T1 = Date.parse("2026-10-13T12:02:00Z");
const T2 = Date.parse("2026-10-14T07:10:00Z");
const d1 = formatNoteDate(T1);
const d2 = formatNoteDate(T2);

function load(markdown: string) {
  const content = new LoroDoc();
  const annotations = new LoroDoc();
  const notices = importMarkdown(markdown, content, annotations, "importer");
  const text = content.getText("content").toString();
  const list = listAnnotations(content, annotations)
    .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
    .map((a) => ({
      type: a.type,
      author: a.author,
      createdAt: a.createdAt,
      excerpt: a.range ? text.slice(a.range.start, a.range.end) : null,
      range: a.range,
      ...(a.body !== undefined && { body: a.body }),
      ...(a.note !== undefined && { note: a.note }),
      replies: a.replies.map((r) => ({ ...r })),
    }));
  return { text, list, notices };
}

describe("ADR-0034 §5, line by line", () => {
  test("1. a mark, its reference, its note: author, date, text and replies", () => {
    const { text, list, notices } = load(
      [
        "Le {==passage==}[^cm-1] continue, {--ce mot--}[^sg-1] part.",
        "",
        `[^cm-1]: **Alice** ${d1} — Faut-il le citer ?`,
        `    **Bob** ${d2} — Oui, au paragraphe 2.`,
        "",
        `[^sg-1]: **Claire** ${d2} — Redondant.`,
        "",
      ].join("\n"),
    );
    expect(text).toBe("Le passage continue, ce mot part.");
    expect(notices).toEqual([]);
    expect(list).toMatchObject([
      {
        type: "comment",
        author: "Alice",
        createdAt: T1,
        excerpt: "passage",
        body: "Faut-il le citer ?",
        replies: [
          { author: "Bob", createdAt: T2, body: "Oui, au paragraphe 2." },
        ],
      },
      {
        type: "deletion",
        author: "Claire",
        createdAt: T2,
        excerpt: "ce mot",
        note: "Redondant.",
        replies: [],
      },
    ]);
  });

  test("1. every kind of suggestion, and an addition's date (suggestAddition takes one)", () => {
    const { list } = load(
      [
        "a{++b++}[^sg-1] {~~c~>d~~}[^sg-2]",
        "",
        `[^sg-1]: **A** ${d1}`,
        `[^sg-2]: **B** ${d2} — mieux`,
      ].join("\n"),
    );
    expect(list).toMatchObject([
      { type: "addition", author: "A", createdAt: T1 },
      { type: "substitution", author: "B", createdAt: T2, note: "mieux" },
    ]);
    expect(list[0]).not.toHaveProperty("note");
  });

  test("2. a suggestion without reference, in a file with notes: the importer's, said", () => {
    const before = Date.now();
    const { list, notices } = load(
      `{--a--} {==b==}[^cm-1]\n\n[^cm-1]: **A** ${d1} — t\n`,
    );
    expect(list[0]).toMatchObject({ type: "deletion", author: "importer" });
    expect(list[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(notices).toEqual([{ kind: "noNote", type: "deletion", at: 0 }]);
  });

  test("2. a reference without a note: the importer's suggestion; a comment with nothing to say, its text kept", () => {
    const { text, list, notices } = load(
      "{--a--}[^sg-1] {==b==}[^cm-1] c[^cm-2]\n\n[^cm-9]: **Z** — elsewhere\n",
    );
    expect(text).toBe("a b c");
    expect(list).toMatchObject([
      { type: "deletion", author: "importer", excerpt: "a" },
      { type: "comment", author: "Z", body: "elsewhere", excerpt: "" },
    ]);
    expect(notices).toEqual([
      { kind: "noNote", name: "sg-1", type: "deletion", at: 0 },
      { kind: "noNote", name: "cm-1", type: "comment", at: 2 },
      { kind: "noNote", name: "cm-2", type: "comment", at: 5 },
      { kind: "orphanNote", name: "cm-9", at: 5 },
    ]);
  });

  test("3. [^sg-N] after no suggestion: decided elsewhere, reference taken out, note ignored", () => {
    const { text, list, notices } = load(
      `Accepté ici[^sg-1], refusé là[^sg-2].\n\n[^sg-1]: **A** ${d1} — x\n[^sg-2]: **B** ${d1}\n`,
    );
    expect(text).toBe("Accepté ici, refusé là.");
    expect(list).toEqual([]);
    expect(notices).toEqual([
      { kind: "decidedOutside", name: "sg-1", at: 11 },
      { kind: "decidedOutside", name: "sg-2", at: 22 },
    ]);
  });

  test("4. [^cm-N] after no highlight: a comment at that point", () => {
    const { text, list, notices } = load(
      `Un mot[^cm-1] seul.\n\n[^cm-1]: **A** ${d1} — ici\n`,
    );
    expect(text).toBe("Un mot seul.");
    expect(list).toMatchObject([
      {
        type: "comment",
        author: "A",
        body: "ici",
        range: { start: 6, end: 6 },
      },
    ]);
    expect(notices).toEqual([]);
  });

  // A comment of blanks only says nothing, and is dropped (import.ts,
  // `normalize`); with replies, they say something: kept.
  test("a comment of blanks with replies is kept, for its replies", () => {
    const { list, notices } = load(
      `Le {==passage==}[^cm-1] suit.\n\n[^cm-1]: **A** ${d1} —  \n    **B** ${d2} — oui\n`,
    );
    expect(list).toMatchObject([
      { type: "comment", replies: [{ author: "B", body: "oui" }] },
    ]);
    expect(notices).toEqual([]);
  });

  test("5. a note without reference: a comment's at the end of the text, a suggestion's ignored", () => {
    const { text, list, notices } = load(
      `Texte modifié.\n\n[^cm-1]: **A** ${d1} — reste\n    **B** ${d2} — oui\n[^sg-1]: **C** ${d1}\n`,
    );
    expect(text).toBe("Texte modifié.");
    expect(list).toMatchObject([
      {
        type: "comment",
        author: "A",
        body: "reste",
        range: { start: 14, end: 14 },
        replies: [{ author: "B", body: "oui" }],
      },
    ]);
    expect(notices).toEqual([
      { kind: "orphanNote", name: "cm-1", at: 14 },
      { kind: "orphanNote", name: "sg-1", at: 14 },
    ]);
  });

  test("6. a name referenced twice: the first takes the note, the next are read without", () => {
    const { text, list, notices } = load(
      `{==a==}[^cm-1] {==b==}[^cm-1] {--c--}[^sg-1] {--d--}[^sg-1]\n\n[^cm-1]: **A** ${d1} — t\n[^sg-1]: **B** ${d1}\n`,
    );
    expect(text).toBe("a b c d");
    expect(list).toMatchObject([
      { type: "comment", author: "A", excerpt: "a" },
      { type: "deletion", author: "B", excerpt: "c" },
      { type: "deletion", author: "importer", excerpt: "d" },
    ]);
    expect(notices).toEqual([
      { kind: "duplicateName", name: "cm-1", at: 2 },
      { kind: "duplicateName", name: "sg-1", at: 6 },
    ]);
  });

  test("6. a name defined twice: the first definition counts, said", () => {
    const { list, notices } = load(
      "{==a==}[^cm-1]\n\n[^cm-1]: **A** — first\n[^cm-1]: **B** — second\n",
    );
    expect(list).toMatchObject([{ author: "A", body: "first" }]);
    expect(notices).toEqual([{ kind: "duplicateName", name: "cm-1", at: 1 }]);
  });

  test("7. a highlight without reference nor comment: text, its marks taken out", () => {
    const { text, list, notices } = load("Un {==surlignage==} nu.");
    expect(text).toBe("Un surlignage nu.");
    expect(list).toEqual([]);
    expect(notices).toEqual([{ kind: "bareHighlight", at: 3 }]);
  });

  test("8. references in a code block are read as elsewhere", () => {
    const { text, list } = load(
      "```\n{==x==}[^cm-1]\n```\n\n[^cm-1]: **A** — dans le code\n",
    );
    expect(text).toBe("```\nx\n```");
    expect(list).toMatchObject([{ type: "comment", excerpt: "x" }]);
  });
});

describe("what stays as before (ADR-0034 §3)", () => {
  test("the standard {==range==}{>>text<<}: a comment on that range", () => {
    const { text, list, notices } = load(
      "Le {==passage==}{>>pourquoi ?<<} suit.",
    );
    expect(text).toBe("Le passage suit.");
    expect(list).toMatchObject([
      {
        type: "comment",
        author: "importer",
        excerpt: "passage",
        body: "pourquoi ?",
      },
    ]);
    expect(notices).toEqual([]);
  });

  test("plain CriticMarkup, without notes: the importer's, nothing said", () => {
    const { list, notices } = load("{--a--}{>>why<<} b {>>c<<}");
    expect(list).toMatchObject([
      { type: "deletion", author: "importer", note: "why" },
      { type: "comment", author: "importer", body: "c" },
    ]);
    expect(notices).toEqual([]);
  });

  test("a comment holding a suggestion, and a highlight inside a deletion", () => {
    const { text, list } = load(
      "{==a {--b--}[^sg-1] c==}[^cm-1] {--d {==e==}[^cm-2]--}[^sg-2]\n\n[^cm-1]: **A** — x\n[^sg-1]: **B** —\n[^cm-2]: **C** — y\n[^sg-2]: **D** :\n",
    );
    expect(text).toBe("a b c d e");
    expect(list.map((a) => [a.type, a.author, a.excerpt]).sort()).toEqual(
      [
        ["comment", "A", "a b c"],
        ["deletion", "B", "b"],
        ["comment", "C", "e"],
        ["deletion", "D", "d e"],
      ].sort(),
    );
  });

  test("an empty entry among the replies is skipped; a reply without author is the importer's", () => {
    const { list } = load(
      `{==a==}[^cm-1]\n\n[^cm-1]: **A** ${d1} — t\n    **B** ${d1}\n    **C** ${d1} — ok\n`,
    );
    expect(list[0]?.replies).toEqual([
      { author: "C", createdAt: T1, body: "ok", id: expect.any(String) },
    ]);
  });
});

describe("suggestAddition", () => {
  test("takes a createdAt, for an import", () => {
    const content = new LoroDoc();
    content.getText("content").insert(0, "ab");
    const annotations = new LoroDoc();
    suggestAddition(content, annotations, {
      at: 1,
      text: "x",
      author: "a",
      createdAt: T1,
    });
    expect(listAnnotations(content, annotations)[0]?.createdAt).toBe(T1);
  });
});
