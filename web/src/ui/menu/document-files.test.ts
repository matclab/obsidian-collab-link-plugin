// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  createAnnotation,
  suggestAddition,
  updateStatus,
} from "../../../lib/src/annotations/index.js";
import type { Role } from "../../../lib/src/crypto/index.js";
import { extractNotes } from "../../criticmarkup/notes.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { counter, resetCounters } from "../../perf/index.js";
import { createDocumentFiles } from "./document-files.js";

/** The text part of an export: its notes are dated now. */
const textPart = (markdown: string | undefined) =>
  extractNotes(markdown ?? "").body;

function setUp(role: Role, text = "") {
  const contentDoc = new LoroDoc();
  if (text) {
    contentDoc.getText("content").insert(0, text);
    contentDoc.commit();
  }
  const annotationsDoc = new LoroDoc();
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const index = new AnnotationIndex(contentDoc, annotationsDoc);
  const container = document.createElement("div");
  const saved: { name: string; text: string }[] = [];
  const files = createDocumentFiles(container, {
    editor,
    index,
    role,
    author: () => "carol",
    save: (name, content) =>
      saved.push({ name, text: typeof content === "string" ? content : "" }),
  });
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === label,
    );
  const message = () => container.querySelector(".files-message")?.textContent;
  const chooseFile = async (content: string, meanwhile = () => {}) => {
    const input = container.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("no file input");
    Object.defineProperty(input, "files", {
      value: [new File([content], "doc.md", { type: "text/markdown" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    meanwhile(); // while the file is being read
    await files.imported();
  };
  return {
    contentDoc,
    annotationsDoc,
    editor,
    container,
    saved,
    button,
    message,
    chooseFile,
  };
}

describe("createDocumentFiles", () => {
  test("any role exports the text with its open annotations, or the text alone", () => {
    for (const role of ["read", "suggest", "edit"] as const) {
      const { contentDoc, annotationsDoc, saved, button } = setUp(
        role,
        "hello world",
      );
      suggestAddition(contentDoc, annotationsDoc, {
        at: 11,
        text: "!",
        author: "bob",
      });

      button("Export with annotations (CriticMarkup)")?.click();
      button("Export the text only")?.click();

      expect(saved.map(({ name }) => name)).toEqual([
        "document.annotations.md",
        "document.md",
      ]);
      expect(textPart(saved[0]?.text)).toBe("hello world{++!++}[^sg-1]");
      expect(
        extractNotes(saved[0]?.text ?? "").notes.get("sg-1"),
      ).toMatchObject([{ author: "bob", text: "" }]);
      expect(saved[1]?.text).toBe("hello world");
    }
  });

  test("an export is named after the document's title, if it has one", () => {
    const { saved, button } = setUp("read", "# Compte rendu : mardi\n\ntexte");
    button("Export with annotations (CriticMarkup)")?.click();
    button("Export the text only")?.click();
    expect(saved.map(({ name }) => name)).toEqual([
      "Compte rendu mardi.annotations.md",
      "Compte rendu mardi.md",
    ]);
  });

  // Phase 9, E3: display keeps Loro's update of a cursor whose character
  // was deleted, which may resolve one character off once an insertion
  // concurrent with the deletion arrives; what is written is exact.
  test("exports exact ranges, whatever display kept", () => {
    const { contentDoc, annotationsDoc, saved, button } = setUp("edit", "abcd");
    contentDoc.setPeerId(1n);
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 1,
      end: 3, // "bc"
      author: "bob",
    });
    const other = new LoroDoc();
    other.setPeerId(2n);
    other.import(contentDoc.export({ mode: "snapshot" }));
    other.getText("content").insert(3, "X"); // right after "c", concurrently
    other.commit();
    contentDoc.getText("content").delete(2, 1);
    contentDoc.commit();
    button("Export with annotations (CriticMarkup)")?.click(); // display resolves, and keeps updates
    contentDoc.import(
      other.export({ mode: "update", from: contentDoc.oplogVersion() }),
    );

    button("Export with annotations (CriticMarkup)")?.click();

    expect(textPart(saved.at(-1)?.text)).toBe("a{--b--}[^sg-1]Xd");
  });

  test("says what the export left out, or could not write", () => {
    const { contentDoc, annotationsDoc, saved, button, message } = setUp(
      "read",
      "a {++ b",
    );
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 0,
      end: 0,
      author: "mallory",
      change: new Uint8Array([1]),
    });
    button("Export with annotations (CriticMarkup)")?.click();
    expect(saved).toHaveLength(1);
    expect(message()).toBe(
      "1 annotation left out (its text could not be read). Some text holds a CriticMarkup marker or a note reference, or a note's line starts with **: read back, this file may differ.",
    );

    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 3,
      author: "a",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 2,
      end: 5,
      author: "b",
    });
    button("Export with annotations (CriticMarkup)")?.click();
    expect(saved).toHaveLength(1);
    expect(message()).toBe(
      "Crossing annotations cannot be written in CriticMarkup: decide on one of each pair first, or export the text alone.",
    );
  });

  test("an editor imports a .md into an empty document, and is told what had to change", async () => {
    const { contentDoc, annotationsDoc, container, message, chooseFile } =
      setUp("edit");
    expect(container.querySelector("input[type=file]")).not.toBeNull();

    await chooseFile("hello{>>hi<<} a{++b{>>c<<}++}");

    expect(contentDoc.getText("content").toString()).toBe("hello a");
    expect(annotationsDoc.getMap("annotations").size).toBe(3);
    expect(message()).toBe(
      "Imported. 1 comment inside a proposed addition moved to its insertion point.",
    );
    expect(container.querySelector("input[type=file]")).toBeNull();
  });

  // ADR-0034 §5: what another tool changed, grouped by kind.
  test("an import tells, by kind, what another tool changed", async () => {
    const { message, chooseFile } = setUp("edit");
    await chooseFile(
      [
        "{==a==} b[^sg-1] {==c==}[^cm-2] {==d==}[^cm-2] {--e--}[^sg-3] f",
        "",
        "[^cm-1]: **A** — orphan",
        "[^cm-2]: **B** — t",
        "[^sg-2]: **C** — orphan too",
        "",
      ].join("\n"),
    );
    expect(message()).toBe(
      [
        "Imported.",
        "2 notes without a reference: a comment's discussion is now at the end of the text, a suggestion's was decided elsewhere.",
        "1 suggestion decided outside the application: its note was ignored.",
        "1 name used twice: read without its note after the first.",
        "1 annotation without its note: signed by you and dated now, or, for a comment, left out.",
        "1 highlight without a comment: kept as text.",
      ].join(" "),
    );
  });

  test("an export says how many comments went back to a point", () => {
    const { contentDoc, annotationsDoc, button, message } = setUp(
      "read",
      "one two three",
    );
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start: 4,
      end: 13,
      author: "a",
    });
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "a",
      body: "x",
    });
    button("Export with annotations (CriticMarkup)")?.click();
    expect(message()).toBe(
      "1 comment written as a point: its range crossed a suggestion or another comment, and won't come back.",
    );
  });

  test("refuses a malformed file without writing anything", async () => {
    const { contentDoc, message, chooseFile } = setUp("edit");
    await chooseFile("oops {++ never closed");
    expect(contentDoc.getText("content").length).toBe(0);
    expect(message()).toMatch(/^Not imported: /);
  });

  test("offers no import to other roles, nor once the document has text", () => {
    for (const role of ["read", "suggest"] as const) {
      expect(
        setUp(role).container.querySelector("input[type=file]"),
      ).toBeNull();
    }
    const { editor, container } = setUp("edit");
    editor.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(container.querySelector("input[type=file]")).toBeNull();
    editor.view.dispatch({ changes: { from: 0, to: 1 } });
    expect(container.querySelector("input[type=file]")).not.toBeNull();
  });

  test("refuses an import once someone wrote in the document while the file was read", async () => {
    const { contentDoc, message, chooseFile } = setUp("edit");
    await chooseFile("imported", () => {
      contentDoc.getText("content").insert(0, "typed");
      contentDoc.commit();
    });
    expect(contentDoc.getText("content").toString()).toBe("typed");
    expect(message()).toBe("Not imported: the document is no longer empty.");
  });
});

describe("the journal of the annotations (ADR-0052 §5)", () => {
  test("TA4: an export forks at most ⌈log₂ N⌉ + 1 times per annotation, N the content's changes", () => {
    const { contentDoc, annotationsDoc, button } = setUp("read", "start ");
    contentDoc.setChangeMergeInterval(0);
    const text = contentDoc.getText("content");
    for (let i = 0; i < 4; i++) {
      createAnnotation(contentDoc, annotationsDoc, {
        type: "comment",
        start: 0,
        end: 5,
        author: "alice",
        body: `${i}`,
      });
    }
    for (let i = 0; i < 200; i++) {
      text.insert(text.length, "x");
      contentDoc.setNextCommitTimestamp(1000 + i);
      contentDoc.commit();
    }
    text.delete(0, 6);
    contentDoc.setNextCommitTimestamp(5000);
    contentDoc.commit();
    const changes = [...contentDoc.getAllChanges().values()].flat().length;
    resetCounters();

    button("Export the annotations' journal")?.click();

    expect(counter("annotations.textThen")).toBeGreaterThan(0);
    expect(counter("annotations.textThen")).toBeLessThanOrEqual(
      4 * (Math.ceil(Math.log2(changes)) + 1),
    );
  });

  test("any role exports it: every annotation once, open or closed, in their creation's order, its file named after the title", () => {
    for (const role of ["read", "suggest", "edit"] as const) {
      const { contentDoc, annotationsDoc, saved, button } = setUp(
        role,
        "# Notes\n\nhello world, and more",
      );
      const closed = createAnnotation(contentDoc, annotationsDoc, {
        type: "comment",
        start: 9,
        end: 14,
        author: "alice",
        body: "first",
        createdAt: 1,
      });
      updateStatus(annotationsDoc, closed, "resolved");
      createAnnotation(contentDoc, annotationsDoc, {
        type: "deletion",
        start: 15,
        end: 20,
        author: "bob",
        note: "# not a heading",
        createdAt: 2,
      });

      button("Export the annotations' journal")?.click();

      expect(saved.map((file) => file.name)).toEqual([
        "Notes — annotations.md",
      ]);
      const journal = saved[0]?.text ?? "";
      expect(journal).toContain("# Notes — annotations");
      expect(journal.indexOf("## 1. alice commented")).toBeGreaterThan(0);
      expect(journal.indexOf("## 2. bob suggests deleting")).toBeGreaterThan(
        journal.indexOf("## 1. alice commented"),
      );
      expect(journal).toContain("- State: resolved");
      expect(journal).toContain("Annotated text:\n\n> hello");
      expect(journal).toContain("Annotated text:\n\n> world");
      expect(journal).toContain("Note:\n\n> # not a heading");
    }
  });
});
