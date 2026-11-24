// ADR-0034, *Conséquences* (phase 13, decision 10): what an export with
// notes promises — the round trip, an outside edit, a degraded file.
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type AnnotationsView,
  computeAnnotationsView,
  replyToAnnotation,
  suggestAddition,
  tryCreateAnnotation,
} from "../../lib/src/annotations/index.js";
import { exportMarkdown } from "./export.js";
import { importMarkdown } from "./import.js";
import { extractNotes, opensEntry } from "./notes.js";
import { type ImportNotice, parseCriticMarkup } from "./parse.js";

// Ids in creation order, the same at every run (Hegel replays).
function sequentialIds(): void {
  let next = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`,
  );
}
afterEach(() => vi.restoreAllMocks());

const WORDS = ["one", "two", "three", "four", "\n"];
const date = (tc: TestCase) =>
  tc.draw(gs.integers({ minValue: 0, maxValue: 3_000_000_000_000 }));

/** A document as the page makes it, each annotation of its own author
 * (`p<i>`: its note is found by it), dated, some with replies. */
function drawDocument(tc: TestCase): { text: string; view: AnnotationsView } {
  const text = tc
    .draw(gs.arrays(gs.sampledFrom(WORDS), { minSize: 1, maxSize: 10 }))
    .join(" ");
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  for (let i = 0; i < count; i++) {
    const type = tc.draw(
      gs.sampledFrom([
        "addition",
        "deletion",
        "substitution",
        "comment",
      ] as const),
    );
    const start = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
    const end = tc.draw(
      gs.integers({ minValue: start, maxValue: text.length }),
    );
    const common = {
      author: `p${i}`,
      createdAt: date(tc),
      ...(tc.draw(gs.booleans()) && { note: drawText(tc, `n${i}`) }),
    };
    let id: string | undefined;
    if (type === "addition") {
      id = suggestAddition(contentDoc, annotationsDoc, {
        at: start,
        text: `a${i}`,
        ...common,
      });
    } else if (type === "comment" || start < end) {
      const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
        type,
        start,
        end,
        ...(type === "substitution" && { replacement: `s${i}` }),
        ...(type === "comment"
          ? {
              author: common.author,
              createdAt: common.createdAt,
              body: drawText(tc, `c${i}`),
            }
          : common),
      });
      id = created.ok ? created.id : undefined;
    }
    if (id === undefined) continue;
    for (
      let r = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      r > 0;
      r--
    ) {
      replyToAnnotation(annotationsDoc, id, {
        author: `r${i}${r}`,
        body: drawText(tc, `b${i}${r}`),
        createdAt: date(tc),
      });
    }
  }
  return { text, view: computeAnnotationsView(contentDoc, annotationsDoc) };
}

/** Lines a text may hold (ADR-0047 §6, MA5): in bold, followed or not by
 * a date or a separator, as Markdown writes them. */
const LINES = [
  "plain words",
  "**Non**, parce que",
  "**Important** dans ce cas",
  "**Bob** — oui",
  "**Bob** : oui",
  "**Bob**: oui",
  "**Bob** 2026-10-30 10:00+01:00 oui",
  "**Bob** oui",
  "**Bob**",
];

/** A text of one to three lines, `own` or one of `LINES` first. */
function drawText(tc: TestCase, own: string): string {
  const first = tc.draw(gs.sampledFrom([own, ...LINES]));
  const rest = tc.draw(
    gs.arrays(gs.sampledFrom(LINES), { minSize: 0, maxSize: 2 }),
  );
  return [first, ...rest].join("\n");
}

const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/** What an annotation is, its date to the minute (ADR-0034 §2). */
function identity(
  a: AnnotationsView["annotations"][number],
  view: AnnotationsView,
): string {
  const preview = view.previews.get(a.id);
  return JSON.stringify([
    a.type,
    a.author,
    minute(a.createdAt),
    a.body ?? "",
    a.note ?? "",
    preview?.kind === "valid" ? preview.text : "",
    a.replies.map((r) => [r.author, minute(r.createdAt), r.body]),
  ]);
}

function described(text: string, view: AnnotationsView, withRange: boolean) {
  return view.annotations
    .filter((a) => a.status === "open")
    .map((a) =>
      JSON.stringify([
        identity(a, view),
        a.range && text.slice(a.range.start, a.range.end),
        withRange ? a.range : null,
      ]),
    )
    .sort();
}

function imported(markdown: string) {
  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  const notices = importMarkdown(markdown, contentDoc, annotationsDoc, "carol");
  const text = contentDoc.getText("content").toString();
  return {
    text,
    view: computeAnnotationsView(contentDoc, annotationsDoc),
    notices,
  };
}

/** A clean export: nothing left out, no comment back to a point, nothing
 * that reads back otherwise; `undefined` for the others. */
function cleanExport(text: string, view: AnnotationsView) {
  const exported = exportMarkdown(text, view);
  if (
    exported.kind !== "exported" ||
    exported.ambiguous ||
    exported.omitted > 0 ||
    exported.pointed > 0
  ) {
    return undefined;
  }
  return exported.markdown;
}

/** Runs of the text part outside every mark and reference: where an
 * outside edit lands without touching an annotation. */
function freeRuns(body: string): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let depth = 0;
  let from: number | undefined = 0;
  for (let i = 0; i <= body.length; ) {
    const leaf = ["{~~", "{>>"].find((open) => body.startsWith(open, i));
    const opening = ["{++", "{--", "{=="].find((open) =>
      body.startsWith(open, i),
    );
    const closing = ["++}", "--}", "==}"].find((close) =>
      body.startsWith(close, i),
    );
    const reference = /^\[\^(?:cm|sg)-[1-9][0-9]*\]/.exec(body.slice(i))?.[0];
    const token = leaf
      ? body.indexOf(leaf === "{~~" ? "~~}" : "<<}", i) + 3 - i
      : (opening ?? closing ?? reference)?.length;
    if (token === undefined && i < body.length) {
      i++;
      continue;
    }
    // Not between a mark and its reference: an edit there detaches it.
    const attached = reference !== undefined && from === i;
    if (depth === 0 && from !== undefined && !attached)
      runs.push({ from, to: i });
    if (opening) depth++;
    if (closing) depth--;
    i += token ?? 1;
    from = depth === 0 ? i : undefined;
  }
  return runs.filter((run) => run.from <= run.to);
}

describe("an export with notes (property, ADR-0034)", () => {
  test(
    "round trip: the same text, the same annotations — authors, dates to the minute, texts, replies",
    () =>
      hegel.test(
        (tc) => {
          sequentialIds();
          const { text, view } = drawDocument(tc);
          const markdown = cleanExport(text, view);
          if (markdown === undefined) return;
          const back = imported(markdown);
          expect(back.notices).toEqual([]);
          expect(back.text).toBe(text);
          expect(described(back.text, back.view, true)).toEqual(
            described(text, view, true),
          );
        },
        { testCases: 300 },
      ),
    120_000,
  );

  // MA5 (ADR-0047 §6): the export's warning and the import's reading are
  // one rule.
  test(
    "flagged ambiguous if and only if a line of a text after its first opens an entry",
    () =>
      hegel.test(
        (tc) => {
          sequentialIds();
          const { text, view } = drawDocument(tc);
          const exported = exportMarkdown(text, view);
          // Every open annotation written: none whose text isn't looked at.
          if (exported.kind !== "exported" || exported.omitted > 0) return;
          const misread = view.annotations
            .filter((a) => a.status === "open" && a.range)
            .flatMap((a) => [a.body, a.note, ...a.replies.map((r) => r.body)])
            .some((t) => (t ?? "").split("\n").slice(1).some(opensEntry));
          expect(exported.ambiguous).toBe(misread);
        },
        { testCases: 300 },
      ),
    120_000,
  );

  test(
    "an outside edit: text inserted or deleted outside the marks and notes keeps every annotation, its range shifted",
    () =>
      hegel.test(
        (tc) => {
          sequentialIds();
          const { text, view } = drawDocument(tc);
          const markdown = cleanExport(text, view);
          if (markdown === undefined) return;
          const { body } = extractNotes(markdown);
          const runs = freeRuns(body);
          const run = tc.draw(gs.sampledFrom(runs));
          const at = tc.draw(
            gs.integers({ minValue: run.from, maxValue: run.to }),
          );
          const deleting = tc.draw(gs.booleans()) && at < run.to;
          const removed = deleting
            ? tc.draw(gs.integers({ minValue: 1, maxValue: run.to - at }))
            : 0;
          const inserted = deleting
            ? ""
            : tc.draw(gs.sampledFrom(["x", " new words ", "\n\nA line.\n"]));
          const edited =
            body.slice(0, at) +
            inserted +
            body.slice(at + removed) +
            markdown.slice(body.length);
          // Where the edit lands in the clean text: what is before it.
          const clean = parseCriticMarkup(body.slice(0, at)).text.length;
          const expected =
            text.slice(0, clean) + inserted + text.slice(clean + removed);

          const back = imported(edited);
          expect(back.notices).toEqual([]);
          expect(back.text).toBe(expected);
          expect(described(back.text, back.view, false)).toEqual(
            described(text, view, false),
          );
        },
        { testCases: 300 },
      ),
    120_000,
  );

  test(
    "a degraded file: without a reference, a note or a mark, never an exception, every annotation found or named by a notice",
    () =>
      hegel.test(
        (tc) => {
          sequentialIds();
          const { text, view } = drawDocument(tc);
          const markdown = cleanExport(text, view);
          if (markdown === undefined) return;
          const { body, notes } = extractNotes(markdown);
          // Each annotation's name, by its author (p<i>, unique).
          const nameOf = new Map<string, string>();
          for (const [name, entries] of notes) {
            const author = entries[0]?.author;
            if (author !== undefined) nameOf.set(author, name);
          }
          const degraded = degrade(tc, body, markdown);
          if (degraded === undefined) return;

          const back = imported(degraded);
          const found = new Set(
            back.view.annotations.map((a) => identity(a, back.view)),
          );
          const named = new Set(
            back.notices.flatMap((n: ImportNotice) =>
              "name" in n && n.name !== undefined ? [n.name] : [],
            ),
          );
          // Each loss accounted for by a notice: one that names it, or one
          // of those without a name (`dropped`: a deletion left empty by a
          // removed mark…), each counted once.
          let nameless = back.notices.filter(
            (n) => !("name" in n) || n.name === undefined,
          ).length;
          for (const a of view.annotations) {
            if (found.has(identity(a, view))) continue;
            const name = nameOf.get(a.author);
            if (name !== undefined && named.has(name)) continue;
            if (nameless-- > 0) continue;
            throw new Error(
              `lost without a word: ${identity(a, view)} (${name})\n${degraded}\nnotices ${JSON.stringify(back.notices)}`,
            );
          }
        },
        { testCases: 300 },
      ),
    120_000,
  );
});

/** The file without one reference, one note, or one mark (its two
 * delimiters, or all of it): what another tool, or a hand, does. */
function degrade(
  tc: TestCase,
  body: string,
  markdown: string,
): string | undefined {
  const notesPart = markdown.slice(body.length);
  const references = [...body.matchAll(/\[\^(?:cm|sg)-[1-9][0-9]*\]/g)];
  // A note runs from its definition to the next one, or the end.
  const lines = notesPart.split("\n");
  const starts = lines.flatMap((line, i) =>
    /^\[\^(?:cm|sg)-[1-9][0-9]*\]:/.test(line) ? [i] : [],
  );
  const marks = markPairs(body);
  const kind = tc.draw(
    gs.sampledFrom(["reference", "note", "delimiters", "mark"] as const),
  );
  if (kind === "reference") {
    if (references.length === 0) return undefined;
    const ref = tc.draw(gs.sampledFrom(references));
    const at = ref.index ?? 0;
    return body.slice(0, at) + body.slice(at + ref[0].length) + notesPart;
  }
  if (kind === "note") {
    if (starts.length === 0) return undefined;
    const k = tc.draw(
      gs.integers({ minValue: 0, maxValue: starts.length - 1 }),
    );
    const kept = [
      ...lines.slice(0, starts[k]),
      ...lines.slice(starts[k + 1] ?? lines.length),
    ];
    return body + kept.join("\n");
  }
  if (marks.length === 0) return undefined;
  const { open, close, end } = tc.draw(gs.sampledFrom(marks));
  if (kind === "mark") return body.slice(0, open) + body.slice(end) + notesPart;
  return (
    body.slice(0, open) +
    body.slice(open + 3, close) +
    body.slice(end) +
    notesPart
  );
}

/** Each mark of the text part: where it opens, where its closing
 * delimiter starts, where it ends (a substitution: its whole length). */
function markPairs(
  body: string,
): { open: number; close: number; end: number }[] {
  const pairs: { open: number; close: number; end: number }[] = [];
  const stack: { open: number; closer: string }[] = [];
  for (let i = 0; i < body.length; ) {
    if (body.startsWith("{~~", i)) {
      const end = body.indexOf("~~}", i) + 3;
      const arrow = body.indexOf("~>", i);
      // Its delimiters: `{~~` and `~>new~~}`, the old text kept.
      pairs.push({ open: i, close: arrow, end });
      i = end;
      continue;
    }
    const opener = ["{++", "{--", "{=="].find((o) => body.startsWith(o, i));
    if (opener) {
      stack.push({ open: i, closer: `${opener[1]}${opener[1]}}` });
      i += 3;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && body.startsWith(top.closer, i)) {
      stack.pop();
      pairs.push({ open: top.open, close: i, end: i + 3 });
      i += 3;
      continue;
    }
    i++;
  }
  return pairs;
}
