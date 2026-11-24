// Entries of the annotations doc come from any reviewer, or from another
// client: each one is checked on reading, and a bad one is skipped without
// keeping the others from being read (docs/protocol/03-document.md, D-8).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Cursor, LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { hostileCursorBytes } from "../test-support/hostile-cursor.js";
import {
  createAnnotation,
  listAnnotations,
  resolveAnnotation,
} from "./model.js";

function docs() {
  const content = new LoroDoc();
  content.getText("content").insert(0, "hello world");
  content.commit();
  const annotations = new LoroDoc();
  const good = createAnnotation(content, annotations, {
    type: "comment",
    start: 0,
    end: 5,
    author: "alice",
    body: "hi",
  });
  return { content, annotations, good };
}

/** Writes `fields` as a new entry, `undefined` meaning absent. */
function writeEntry(
  annotations: LoroDoc,
  id: string,
  fields: Record<string, unknown>,
): void {
  const entry = annotations
    .getMap("annotations")
    .setContainer(id, new LoroMap());
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined) entry.set(field, value as never);
  }
  annotations.commit();
}

function cursorBytes(content: LoroDoc, at: number): Uint8Array {
  const cursor = content.getText("content").getCursor(at, 0);
  if (!cursor) throw new Error("no cursor");
  return cursor.encode();
}

function validFields(content: LoroDoc): Record<string, unknown> {
  return {
    type: "deletion",
    author: "bob",
    status: "open",
    createdAt: 1,
    startCursor: cursorBytes(content, 6),
    endCursor: cursorBytes(content, 10),
    endOnLastChar: true,
  };
}

describe("an entry whose cursor would trap (D-37)", () => {
  test.each(["startCursor", "endCursor"])(
    "is listed with an unresolved range, and the text stays usable (%s)",
    (field) => {
      const { content, annotations, good } = docs();
      writeEntry(annotations, "hostile", {
        ...validFields(content),
        [field]: hostileCursorBytes(),
      });

      const listed = listAnnotations(content, annotations);
      expect(listed.map((a) => a.id).sort()).toEqual([good, "hostile"].sort());
      expect(listed.find((a) => a.id === "hostile")?.range).toBeNull();
      expect(
        resolveAnnotation(content, annotations, "hostile")?.range,
      ).toBeNull();
      content.export({ mode: "snapshot" });
      content.getText("content").insert(0, "x");
      content.commit();
    },
  );
});

describe("malformed annotation entries (D-8)", () => {
  test.each<[string, (content: LoroDoc) => Record<string, unknown>]>([
    ["no start cursor", () => ({ startCursor: undefined })],
    ["no end cursor", () => ({ endCursor: undefined })],
    [
      "a cursor that doesn't decode",
      () => ({ startCursor: new Uint8Array([1, 2, 3]) }),
    ],
    ["an empty cursor", () => ({ endCursor: new Uint8Array(0) })],
    ["a cursor that isn't bytes", () => ({ startCursor: "abc" })],
    ["a cursor on another container", () => ({ endCursor: FOREIGN_CURSOR })],
    ["an unknown type", () => ({ type: "highlight" })],
    ["no type", () => ({ type: undefined })],
    ["an unknown status", () => ({ status: "closed" })],
    ["an author that isn't a string", () => ({ author: 7 })],
    ["no createdAt", () => ({ createdAt: undefined })],
    [
      "a createdAt that isn't finite",
      () => ({ createdAt: Number.POSITIVE_INFINITY }),
    ],
    ["a createdAt that isn't a number", () => ({ createdAt: "1" })],
    ["an endOnLastChar that isn't a boolean", () => ({ endOnLastChar: "yes" })],
    ["a change that isn't bytes", () => ({ change: "text" })],
    ["a body that isn't a string", () => ({ body: 3 })],
    ["a note that isn't a string", () => ({ note: true })],
  ])("%s: skipped, the others still listed", (_, override) => {
    const { content, annotations, good } = docs();
    writeEntry(annotations, "bad", {
      ...validFields(content),
      ...override(content),
    });

    expect(listAnnotations(content, annotations).map((a) => a.id)).toEqual([
      good,
    ]);
    expect(resolveAnnotation(content, annotations, "bad")).toBeUndefined();
  });

  test("an entry that isn't a map is skipped", () => {
    const { content, annotations, good } = docs();
    annotations.getMap("annotations").set("bad", "not an entry");
    annotations.commit();

    expect(listAnnotations(content, annotations).map((a) => a.id)).toEqual([
      good,
    ]);
    expect(resolveAnnotation(content, annotations, "bad")).toBeUndefined();
  });

  test("a well-formed entry with unknown fields and endOnLastChar false is listed", () => {
    const { content, annotations } = docs();
    writeEntry(annotations, "ok", {
      ...validFields(content),
      endOnLastChar: false,
      priority: "high",
    });

    expect(resolveAnnotation(content, annotations, "ok")).toMatchObject({
      type: "deletion",
      author: "bob",
      status: "open",
      range: { start: 6, end: 10 },
    });
  });
});

// Each field's valid values, wrong ones, and absence: listing never
// throws, and keeps exactly the entries D-8 allows.
const VALUES: Record<string, (cursor: Uint8Array) => unknown[]> = {
  type: () => [
    undefined,
    "comment",
    "addition",
    "deletion",
    "substitution",
    "highlight",
    5,
  ],
  status: () => [
    undefined,
    "open",
    "accepted",
    "rejected",
    "resolved",
    "closed",
    true,
  ],
  author: () => [undefined, "a", "", 3],
  createdAt: () => [
    undefined,
    1,
    0.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    "1",
  ],
  startCursor: (cursor) => [
    undefined,
    cursor,
    new Uint8Array([1, 2, 3]),
    new Uint8Array(0),
    "x",
    FOREIGN_CURSOR,
  ],
  endCursor: (cursor) => [undefined, cursor, new Uint8Array([0]), 2],
  endOnLastChar: () => [undefined, true, false, "yes"],
  change: () => [undefined, new Uint8Array([1]), "x"],
  body: () => [undefined, "t", 7],
  note: () => [undefined, "n", null],
};

/** Decodes, but on a container other than the root text `content`: the
 * entry is invalid (G2, D-8). */
const FOREIGN_CURSOR = (() => {
  const other = new LoroDoc();
  other.getText("other").insert(0, "zz");
  return other.getText("other").getCursor(1, 0)?.encode();
})();

const TYPES = ["comment", "addition", "deletion", "substitution"];
const STATUSES = ["open", "accepted", "rejected", "resolved"];

const bytes = (value: unknown) => value instanceof Uint8Array;
const optional = (check: (value: unknown) => boolean) => (value: unknown) =>
  value === undefined || check(value);
const decodable = (value: unknown) => {
  if (!bytes(value)) return false;
  try {
    return (
      Cursor.decode(value as Uint8Array).containerId() ===
      "cid:root-content:Text"
    );
  } catch {
    return false;
  }
};

/** D-8, field by field: the model the listing is checked against. */
const FIELD_OK: Record<string, (value: unknown) => boolean> = {
  type: (value) => TYPES.includes(value as string),
  status: (value) => STATUSES.includes(value as string),
  author: (value) => typeof value === "string",
  createdAt: (value) => typeof value === "number" && Number.isFinite(value),
  startCursor: decodable,
  endCursor: decodable,
  endOnLastChar: optional((value) => typeof value === "boolean"),
  change: optional(bytes),
  body: optional((value) => typeof value === "string"),
  note: optional((value) => typeof value === "string"),
};

function allowed(fields: Record<string, unknown>): boolean {
  return Object.entries(FIELD_OK).every(([field, ok]) => ok(fields[field]));
}

describe("any annotation entry (property, D-8)", () => {
  test("listing never throws, and keeps exactly the well-formed entries", () =>
    hegel.test(
      (tc) => {
        const { content, annotations, good } = docs();
        const cursor = cursorBytes(content, 2);
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const expected = [good];
        for (let i = 0; i < count; i++) {
          // A valid entry, then zero to two fields drawn among every value:
          // drawn independently, a single wrong field among valid ones
          // would be rare.
          const fields: Record<string, unknown> = {};
          for (const [field, values] of Object.entries(VALUES)) {
            const ok = FIELD_OK[field] ?? (() => true);
            fields[field] = tc.draw(
              gs.sampledFrom(values(cursor).filter((value) => ok(value))),
            );
          }
          const broken = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
          for (let j = 0; j < broken; j++) {
            const field = tc.draw(gs.sampledFrom(Object.keys(VALUES)));
            fields[field] = tc.draw(
              gs.sampledFrom(VALUES[field]?.(cursor) ?? [undefined]),
            );
          }
          writeEntry(annotations, `e${i}`, fields);
          if (allowed(fields)) expected.push(`e${i}`);
        }

        const listed = listAnnotations(content, annotations).map((a) => a.id);
        expect(listed.sort()).toEqual(expected.sort());
        for (let i = 0; i < count; i++) {
          resolveAnnotation(content, annotations, `e${i}`);
        }
      },
      { testCases: 300 },
    ));
});
