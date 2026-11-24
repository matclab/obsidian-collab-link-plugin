// Replies to an annotation (ADR-0035; docs/protocol/03-document.md, D-38,
// D-39; 04-obligations.md, O-39): a flat thread in the annotation's entry.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { MAX_TEXT_BYTES, TextTooLarge } from "./detached.js";
import {
  createAnnotation,
  listAnnotations,
  replyToAnnotation,
  resolveAnnotation,
  updateStatus,
} from "./model.js";

function docs() {
  const content = new LoroDoc();
  content.getText("content").insert(0, "hello world");
  content.commit();
  const annotations = new LoroDoc();
  const id = createAnnotation(content, annotations, {
    type: "deletion",
    start: 0,
    end: 5,
    author: "alice",
  });
  return { content, annotations, id };
}

/** How many commits `act` made on `doc`. */
function commits(doc: LoroDoc, act: () => void): number {
  let made = 0;
  const unsubscribe = doc.subscribePreCommit(() => {
    made++;
  });
  try {
    act();
  } finally {
    unsubscribe();
  }
  return made;
}

const entryOf = (annotations: LoroDoc, id: string) =>
  annotations.getMap("annotations").get(id) as LoroMap;

describe("replies (D-38, O-39)", () => {
  test("an annotation is created with an empty list of replies, in the same commit", () => {
    const { content, annotations } = docs();
    let id = "";
    const made = commits(annotations, () => {
      id = createAnnotation(content, annotations, {
        type: "comment",
        start: 0,
        end: 1,
        author: "bob",
        body: "x",
      });
    });

    expect(made).toBe(1);
    expect(entryOf(annotations, id).get("replies")).toBeInstanceOf(LoroList);
    expect(resolveAnnotation(content, annotations, id)?.replies).toEqual([]);
  });

  test("a reply is appended at the end, its fields and its id (ID-10) in one commit", () => {
    const { content, annotations, id } = docs();

    const made = commits(annotations, () => {
      replyToAnnotation(annotations, id, {
        author: "bob",
        body: "why?",
        createdAt: 20,
      });
      replyToAnnotation(annotations, id, {
        author: "alice",
        body: "a typo",
        createdAt: 10,
      });
    });

    const anyId = expect.stringMatching(/^[0-9a-f-]{36}$/);
    expect(resolveAnnotation(content, annotations, id)?.replies).toEqual([
      { author: "bob", createdAt: 20, body: "why?", id: anyId },
      { author: "alice", createdAt: 10, body: "a typo", id: anyId },
    ]);
    expect(made).toBe(2);
  });

  test("createdAt defaults to now", () => {
    const { content, annotations, id } = docs();
    const before = Date.now();

    replyToAnnotation(annotations, id, { author: "bob", body: "x" });

    const [reply] = resolveAnnotation(content, annotations, id)?.replies ?? [];
    expect(reply?.createdAt).toBeGreaterThanOrEqual(before);
    expect(reply?.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("an annotation without a list (an older client's) gets one with the reply", () => {
    const { content, annotations, id } = docs();
    entryOf(annotations, id).delete("replies");
    annotations.commit();

    replyToAnnotation(annotations, id, { author: "bob", body: "first" });

    expect(
      resolveAnnotation(content, annotations, id)?.replies.map((r) => r.body),
    ).toEqual(["first"]);
  });

  test("a reply to a closed annotation is kept: the status is the interface's business", () => {
    const { content, annotations, id } = docs();
    updateStatus(annotations, id, "rejected");

    replyToAnnotation(annotations, id, { author: "bob", body: "late" });

    expect(resolveAnnotation(content, annotations, id)).toMatchObject({
      status: "rejected",
      replies: [{ author: "bob", body: "late" }],
    });
  });

  test("refuses an unknown annotation, and an empty text, writing nothing", () => {
    const { annotations, id } = docs();
    const version = annotations.version().toJSON();

    expect(() =>
      replyToAnnotation(annotations, "nope", { author: "bob", body: "x" }),
    ).toThrow();
    expect(() =>
      replyToAnnotation(annotations, id, { author: "bob", body: "" }),
    ).toThrow();
    expect(annotations.version().toJSON()).toEqual(version);
  });

  test("two concurrent replies are both kept, in the same order at both peers", () => {
    const { content, annotations, id } = docs();
    const other = new LoroDoc();
    other.import(annotations.export({ mode: "snapshot" }));

    replyToAnnotation(annotations, id, { author: "alice", body: "a" });
    replyToAnnotation(other, id, { author: "bob", body: "b" });
    annotations.import(other.export({ mode: "update" }));
    other.import(annotations.export({ mode: "update" }));

    const thread = (doc: LoroDoc) =>
      resolveAnnotation(content, doc, id)?.replies.map((r) => r.body);
    expect(thread(annotations)?.sort()).toEqual(["a", "b"]);
    expect(thread(other)).toEqual(thread(annotations));
  });
});

describe("a bound on every free text (O-18)", () => {
  const tooLarge = "x".repeat(MAX_TEXT_BYTES + 1);

  test("a reply over the bound is refused", () => {
    const { annotations, id } = docs();
    expect(() =>
      replyToAnnotation(annotations, id, { author: "bob", body: tooLarge }),
    ).toThrow(TextTooLarge);
  });

  test("a comment's body over the bound is refused, writing nothing", () => {
    const { content, annotations } = docs();
    expect(() =>
      createAnnotation(content, annotations, {
        type: "comment",
        start: 0,
        end: 1,
        author: "bob",
        body: tooLarge,
      }),
    ).toThrow(TextTooLarge);
    expect(listAnnotations(content, annotations)).toHaveLength(1);
  });

  test("a body of multi-byte characters is counted in UTF-8 bytes", () => {
    const { annotations, id } = docs();
    const body = "é".repeat(MAX_TEXT_BYTES / 2 + 1); // 2 bytes each
    expect(() =>
      replyToAnnotation(annotations, id, { author: "bob", body }),
    ).toThrow(TextTooLarge);
  });
});

describe("createdAt given at creation (an import, ADR-0034)", () => {
  test("is the one written", () => {
    const { content, annotations } = docs();
    const id = createAnnotation(content, annotations, {
      type: "comment",
      start: 0,
      end: 1,
      author: "bob",
      body: "x",
      createdAt: 1_600_000_000_000,
    });
    expect(resolveAnnotation(content, annotations, id)?.createdAt).toBe(
      1_600_000_000_000,
    );
  });
});

// D-39: any element, any `replies`. Listing never throws, the entry is
// always read, and its replies are exactly the well-formed elements, in
// the list's order.
const FIELD_VALUES: Record<string, unknown[]> = {
  author: [undefined, "bob", "", 3, null],
  createdAt: [undefined, 1, 0.5, -2, Number.NaN, Number.POSITIVE_INFINITY, "1"],
  body: [undefined, "hi", "", 7, true],
  extra: [undefined, "unknown field"],
};
const replyOk = (fields: Record<string, unknown>) =>
  typeof fields.author === "string" &&
  typeof fields.createdAt === "number" &&
  Number.isFinite(fields.createdAt) &&
  typeof fields.body === "string" &&
  fields.body !== "";

describe("any replies (property, D-39)", () => {
  test("listing never throws, and keeps exactly the well-formed replies, in order", () =>
    hegel.test(
      (tc) => {
        const { content, annotations, id } = docs();
        const entry = entryOf(annotations, id);
        const shape = tc.draw(
          gs.sampledFrom(["list", "map", "value", "absent"] as const),
        );
        const expected: unknown[] = [];
        if (shape === "map") entry.setContainer("replies", new LoroMap());
        if (shape === "value") entry.set("replies", "not a list");
        if (shape === "absent") entry.delete("replies");
        if (shape === "list") {
          const list = entry.get("replies") as LoroList;
          const count = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
          for (let i = 0; i < count; i++) {
            const kind = tc.draw(
              gs.sampledFrom(["map", "value", "list"] as const),
            );
            if (kind === "value") {
              list.push(tc.draw(gs.sampledFrom(["text", 4, null, true])));
              continue;
            }
            if (kind === "list") {
              list.insertContainer(list.length, new LoroList());
              continue;
            }
            // A valid reply, then zero to two fields drawn among every
            // value (as for D-8's property).
            const fields: Record<string, unknown> = {
              author: "bob",
              createdAt: i,
              body: `r${i}`,
              extra: undefined,
            };
            const broken = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
            for (let j = 0; j < broken; j++) {
              const field = tc.draw(gs.sampledFrom(Object.keys(FIELD_VALUES)));
              fields[field] = tc.draw(
                gs.sampledFrom(FIELD_VALUES[field] ?? [undefined]),
              );
            }
            const reply = list.insertContainer(list.length, new LoroMap());
            for (const [field, value] of Object.entries(fields)) {
              if (value !== undefined) reply.set(field, value as never);
            }
            if (replyOk(fields)) {
              expected.push({
                author: fields.author,
                createdAt: fields.createdAt,
                body: fields.body,
              });
            }
          }
        }
        annotations.commit();

        const listed = listAnnotations(content, annotations);
        expect(listed.map((a) => a.id)).toEqual([id]);
        expect(listed[0]?.replies).toEqual(expected);
      },
      { testCases: 300 },
    ));
});
