// « Mes documents » as the list shows it (decision 19; 18d): excluded
// documents never shown, a filter on the title and the identifier, sorted
// by last opening (never opened last) or by title.
import { describe, expect, test } from "vitest";
import type { KeyringEntry } from "../../lib/src/index.js";
import { visibleEntries } from "./list-model.js";

const entry = (
  documentId: string,
  title: string | null,
  openedAt: number | null,
  extra: Partial<KeyringEntry> = {},
): KeyringEntry => ({
  documentId,
  title,
  openedAt,
  state: "ok",
  role: "edit",
  link: `https://h/?doc=${documentId}`,
  createdHere: false,
  excluded: false,
  ...extra,
});

const ENTRIES = [
  entry("a1", "Zèbre", 10),
  entry("b2", "alpha", 30),
  entry("c3", null, null),
  entry("d4", "Éléphant", 20),
  entry("e5", "hidden", 99, { excluded: true }),
];

describe("the list of « Mes documents »", () => {
  test("by last opening, never opened last; excluded never shown", () => {
    expect(
      visibleEntries(ENTRIES, { filter: "", sort: "recent" }).map(
        (e) => e.documentId,
      ),
    ).toEqual(["b2", "d4", "a1", "c3"]);
  });

  test("by title, accents and case aside, untitled last", () => {
    expect(
      visibleEntries(ENTRIES, {
        filter: "",
        sort: "title",
        language: "fr",
      }).map((e) => e.documentId),
    ).toEqual(["b2", "d4", "a1", "c3"]);
  });

  test("a filter on the title, accents and case aside, or the identifier", () => {
    expect(
      visibleEntries(ENTRIES, { filter: "ELEPH", sort: "recent" }).map(
        (e) => e.documentId,
      ),
    ).toEqual(["d4"]);
    expect(
      visibleEntries(ENTRIES, { filter: "c3", sort: "recent" }).map(
        (e) => e.documentId,
      ),
    ).toEqual(["c3"]);
    expect(
      visibleEntries(ENTRIES, { filter: "  ", sort: "recent" }),
    ).toHaveLength(4);
  });
});
