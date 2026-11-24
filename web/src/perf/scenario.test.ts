import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { listAnnotations } from "../../lib/src/annotations/index.js";
import {
  LONG_HISTORY_LENGTH,
  generateJournal,
  generateLongHistory,
} from "./scenario.js";

describe("generateJournal", () => {
  test("pads the history with typing, and every annotation ends decided or resolved", () => {
    const journal = generateJournal({ annotations: 8, entries: 120 });
    expect(journal.length).toBe(120);

    const content = new LoroDoc();
    const annotations = new LoroDoc();
    content.importBatch(
      journal.filter((e) => e.channel === "content").map((e) => e.plaintext),
    );
    annotations.importBatch(
      journal
        .filter((e) => e.channel === "annotations")
        .map((e) => e.plaintext),
    );
    const listed = listAnnotations(content, annotations);
    expect(listed).toHaveLength(8);
    expect(listed.every((a) => a.status !== "open")).toBe(true);
    // A proposal per annotation: resolving a comment is one too (ADR-0018).
    expect(journal.filter((e) => e.channel === "decisions")).toHaveLength(8);
    expect(content.getText("content").toString()).toContain("add");
  });

  test("is deterministic apart from annotation ids", () => {
    const sizes = (n: number) =>
      generateJournal({ annotations: 4, entries: n }).map((e) => e.channel);
    expect(sizes(60)).toEqual(sizes(60));
  });
});

describe("generateLongHistory", () => {
  test("applies the operations on content of constant length, as two authors", () => {
    const content = generateLongHistory(10_000);
    const total = [...content.oplogVersion().toJSON().values()].reduce(
      (sum, counter) => sum + counter,
      0,
    );
    expect(total).toBe(10_000);
    expect(content.oplogVersion().toJSON().size).toBe(2);
    expect(content.getText("content").length).toBe(LONG_HISTORY_LENGTH);
  });

  test("is deterministic", () => {
    const snapshot = () =>
      generateLongHistory(2_000).export({ mode: "snapshot" });
    expect(snapshot()).toEqual(snapshot());
  });
});
