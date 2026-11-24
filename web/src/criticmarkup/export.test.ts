import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  checkDetachedChange,
  computeAnnotationsView,
  createAnnotation,
  createDetachedChange,
  replyToAnnotation,
  suggestAddition,
  tryCreateAnnotation,
  updateStatus,
} from "../../lib/src/annotations/index.js";
import { exportMarkdown } from "./export.js";
import { extractNotes } from "./notes.js";

/** The text part of an export, and its notes. */
function parts(result: ReturnType<typeof exportMarkdown>) {
  if (result.kind !== "exported") throw new Error(result.kind);
  return extractNotes(result.markdown);
}

function setUp(text: string) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const exported = () =>
    exportMarkdown(
      contentDoc.getText("content").toString(),
      computeAnnotationsView(contentDoc, annotationsDoc),
    );
  return { contentDoc, annotationsDoc, exported };
}

describe("exportMarkdown", () => {
  test("writes the open annotations in CriticMarkup, proposed texts taken from their changes", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("hello big world");
    const author = "alice";
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      author,
      body: "hi",
    });
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 6,
      end: 9,
      author,
      replacement: "small",
    });
    suggestAddition(contentDoc, annotationsDoc, {
      at: 15,
      text: "!",
      author,
      note: "louder",
    });
    const closed = createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 10,
      end: 15,
      author,
    });
    updateStatus(annotationsDoc, closed, "rejected");

    const result = exported();
    expect(result).toMatchObject({
      kind: "exported",
      omitted: 0,
      ambiguous: false,
      pointed: 0,
    });
    const { body, notes } = parts(result);
    expect(body).toBe(
      "{==hello==}[^cm-1] {~~big~>small~~}[^sg-1] world{++!++}[^sg-2]",
    );
    expect(notes.get("cm-1")).toMatchObject([{ author, text: "hi" }]);
    expect(notes.get("sg-2")).toMatchObject([{ author, text: "louder" }]);
  });

  test("leaves out and counts what cannot be written: an unreadable or not yet arrived proposed text", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("hello world");
    const author = "mallory";
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 5,
      end: 5,
      author,
      change: new Uint8Array([1, 2, 3]),
    });
    // A change made on a text this client has not received yet.
    const ahead = contentDoc.fork();
    ahead.getText("content").insert(0, "later ");
    ahead.commit();
    const id = crypto.randomUUID();
    const change = createDetachedChange(ahead, id, 3, "x");
    createAnnotation(
      contentDoc,
      annotationsDoc,
      { type: "addition", start: 0, end: 0, author, change },
      id,
    );
    expect(checkDetachedChange(contentDoc, id, change).kind).toBe("pending");
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 6,
      end: 11,
      author,
    });

    const result = exported();
    expect(result).toMatchObject({
      kind: "exported",
      omitted: 2,
      ambiguous: false,
    });
    expect(parts(result).body).toBe("hello {--world--}[^sg-1]");
  });

  test("refuses crossing annotations, which CriticMarkup cannot write", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("hello world");
    const author = "alice";
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 7,
      author,
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 3,
      end: 11,
      author,
    });

    expect(exported()).toEqual({ kind: "crossing", pairs: 1 });
  });

  test.each([
    ["the text", "write {++ to add", {}],
    ["a comment", "hello", { body: "use ~> here" }],
    ["a note", "hello", { note: "not <<} this" }],
    ["the text, a highlight", "see {== here", {}],
    ["the text, a note reference", "see[^cm-1]", {}],
    ["the text, a note's definition", "x\n\n[^sg-2]: y", {}],
    ["a comment, a reference", "hello", { body: "as [^sg-1] says" }],
    [
      "a line of a comment, an author in bold then a separator",
      "hello",
      { body: "one\n**two** — three" },
    ],
    [
      "a line of a note, an author in bold then a date",
      "hello",
      { note: "one\n**two** 2026-10-30 10:00+01:00" },
    ],
    ["an author, a star", "hello", { author: "a*b" }],
    ["an author, a blank around", "hello", { author: "ab " }],
  ])("warns when %s: read back, the file may differ", (_, text, extra) => {
    const { contentDoc, annotationsDoc, exported } = setUp(text);
    createAnnotation(contentDoc, annotationsDoc, {
      type: "body" in extra ? "comment" : "deletion",
      start: 0,
      end: 2,
      author: "alice",
      ...extra,
    });

    expect(exported()).toMatchObject({ kind: "exported", ambiguous: true });
  });

  test("warns when a reply holds what reads back otherwise", () => {
    for (const [author, body] of [
      ["bob", "one\n**two**: three"],
      ["bob", "see {--this"],
      ["b*b", "fine"],
    ]) {
      const { contentDoc, annotationsDoc, exported } = setUp("hello");
      const id = createAnnotation(contentDoc, annotationsDoc, {
        type: "deletion",
        start: 0,
        end: 2,
        author: "alice",
      });
      replyToAnnotation(annotationsDoc, id, {
        author: author ?? "",
        body: body ?? "",
      });
      expect(exported(), `${author}: ${body}`).toMatchObject({
        ambiguous: true,
      });
    }
  });

  test("a first line in bold, or an indented one, is not ambiguous: neither starts an entry", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("hello");
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 2,
      author: "alice",
      body: "**important** — x\n  **indented** — y",
    });
    expect(exported()).toMatchObject({ ambiguous: false });
  });

  // ADR-0047 §6: in Markdown, a line in bold is common; it opens an entry
  // only with a date or a separator after it.
  test("a later line in bold, followed by neither a date nor a separator, is not ambiguous", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("hello");
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 2,
      author: "alice",
      body: "Voir :\n**Non**, parce que…\n**Important** dans ce cas.\n**two**",
    });
    expect(exported()).toMatchObject({ ambiguous: false });
  });

  test("counts the comments gone back to a point", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("one two three");
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 4,
      end: 13,
      author: "alice",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "alice",
      body: "x",
    });
    const result = exported();
    expect(result).toMatchObject({ kind: "exported", pointed: 1 });
    expect(parts(result).body).toBe("one {--two[^cm-1] three--}[^sg-1]");
  });

  test("keeps the suggestions and comments inside a comment's range", () => {
    const { contentDoc, annotationsDoc, exported } =
      setUp("one two three four");
    const author = "alice";
    suggestAddition(contentDoc, annotationsDoc, { at: 3, text: "!", author });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 4,
      end: 8,
      author,
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 8,
      end: 13,
      author,
      body: "inner",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 18,
      author,
      body: "all",
    });

    expect(parts(exported()).body).toBe(
      "{==one{++!++}[^sg-1] {--two --}[^sg-2]{==three==}[^cm-1] four==}[^cm-2]",
    );
  });

  test("a comment right after a suggestion is no longer ambiguous: its reference names it", () => {
    const { contentDoc, annotationsDoc, exported } = setUp("ab");
    const author = "alice";
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 0,
      end: 1,
      author,
      replacement: "x",
    });
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 1,
      end: 2,
      author,
      replacement: "y",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 1,
      end: 2,
      author,
      body: "c",
    });

    const result = exported();
    expect(result).toMatchObject({ ambiguous: false, pointed: 0 });
    expect(parts(result).body).toBe(
      "{~~a~>x~~}[^sg-1]{=={~~b~>y~~}[^sg-2]==}[^cm-1]",
    );
  });
});
