import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { computeAnnotationsView } from "../../lib/src/annotations/index.js";
import { importMarkdown } from "./import.js";

describe("importMarkdown", () => {
  test("puts the clean text in content and each annotation in the annotations doc, as the importer's", () => {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();

    const notices = importMarkdown(
      "hello{>>hi<<} {~~big~>small~~}{>>why<<} {--old--}world{++!++}",
      contentDoc,
      annotationsDoc,
      "carol",
    );

    expect(notices).toEqual([]);
    expect(contentDoc.getText("content").toString()).toBe("hello big oldworld");
    const view = computeAnnotationsView(contentDoc, annotationsDoc);
    // Created in the same millisecond: in text order, not creation order.
    const summary = [...view.annotations]
      .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
      .map((a) => {
        const preview = view.previews.get(a.id);
        return {
          type: a.type,
          author: a.author,
          status: a.status,
          range: a.range,
          body: a.body,
          note: a.note,
          proposed: preview?.kind === "valid" ? preview.text : undefined,
        };
      });
    expect(summary).toEqual([
      {
        type: "comment",
        author: "carol",
        status: "open",
        range: { start: 5, end: 5 },
        body: "hi",
        note: undefined,
        proposed: undefined,
      },
      {
        type: "substitution",
        author: "carol",
        status: "open",
        range: { start: 6, end: 9 },
        body: undefined,
        note: "why",
        proposed: "small",
      },
      {
        type: "deletion",
        author: "carol",
        status: "open",
        range: { start: 10, end: 13 },
        body: undefined,
        note: undefined,
        proposed: undefined,
      },
      {
        type: "addition",
        author: "carol",
        status: "open",
        range: { start: 18, end: 18 },
        body: undefined,
        note: undefined,
        proposed: "!",
      },
    ]);
  });

  test("returns what had to be moved or dropped", () => {
    const notices = importMarkdown(
      "a{++b{>>c<<}++}",
      new LoroDoc(),
      new LoroDoc(),
      "carol",
    );
    expect(notices).toEqual([{ kind: "moved", type: "comment", at: 1 }]);
  });

  test("keeps the meaning of an empty side: nothing proposed or deleted is dropped, a substitution with an empty side is a deletion or an addition", () => {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();

    const notices = importMarkdown(
      "a{++++}b{~~c~>~~}d{~~~>e~~}f{----}{~~~>~~}",
      contentDoc,
      annotationsDoc,
      "carol",
    );

    expect(notices).toEqual([
      { kind: "dropped", type: "addition", at: 1 },
      { kind: "dropped", type: "deletion", at: 5 },
      { kind: "dropped", type: "deletion", at: 5 },
    ]);
    expect(contentDoc.getText("content").toString()).toBe("abcdf");
    const view = computeAnnotationsView(contentDoc, annotationsDoc);
    const kinds = [...view.annotations]
      .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
      .map((a) => {
        const preview = view.previews.get(a.id);
        return [
          a.type,
          a.range?.start,
          a.range?.end,
          preview?.kind === "valid" ? preview.text : undefined,
        ];
      });
    expect(kinds).toEqual([
      ["deletion", 2, 3, undefined],
      ["addition", 4, 4, "e"],
    ]);
  });

  test("drops an empty comment, which says nothing", () => {
    const annotationsDoc = new LoroDoc();
    const notices = importMarkdown(
      "a{>><<}b",
      new LoroDoc(),
      annotationsDoc,
      "carol",
    );

    expect(notices).toEqual([{ kind: "dropped", type: "comment", at: 1 }]);
    expect(annotationsDoc.getMap("annotations").size).toBe(0);
  });

  // Found by the import/export property: a comment of a space came in,
  // and its own export was then dropped — what is only blanks says
  // nothing either.
  test("drops a comment of blanks only, on a passage or not", () => {
    for (const markdown of ["a{>> <<}b", "{==a==}{>> \t\n <<}b"]) {
      const annotationsDoc = new LoroDoc();
      const notices = importMarkdown(
        markdown,
        new LoroDoc(),
        annotationsDoc,
        "carol",
      );

      expect(notices.map((n) => [n.kind, "type" in n && n.type])).toEqual([
        ["dropped", "comment"],
      ]);
      expect(annotationsDoc.getMap("annotations").size).toBe(0);
    }
  });

  // ADR-0034: an entry of a note keeps no blanks at the end of its lines
  // nor before its first; a comment or a note written in the text takes
  // that form at once, as its export would read back (phase 33e).
  test("writes a comment's and a note's text as a note would read it back", () => {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();
    importMarkdown(
      "x{>>  a \n  b  \n\n<<} {~~y~>z~~}{>> why <<}",
      contentDoc,
      annotationsDoc,
      "carol",
    );

    const view = computeAnnotationsView(contentDoc, annotationsDoc);
    expect(
      view.annotations.map((a) => [a.type, a.body ?? a.note]).sort(),
    ).toEqual([
      ["comment", "a\n  b"],
      ["substitution", "why"],
    ]);
  });
});
