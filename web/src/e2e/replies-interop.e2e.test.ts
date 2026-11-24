// @vitest-environment node
//
// Phase 13a.3 (decision 5): replies are written by any editor or reviewer
// (ADR-0035), and every client must show the same thread (D-38, D-39).
// The official reading against the independent client's (written from the
// specification alone, on Loro 1.16.3), on threads a reviewer could write:
// well-formed or malformed elements, a `replies` of another type,
// concurrent replies from several peers.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createAnnotation,
  listAnnotations,
  replyToAnnotation,
} from "../../lib/src/annotations/model.js";
import { linkIndependentLoro } from "./independent-loro.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;
// biome-ignore lint/suspicious/noExplicitAny: the other Loro module.
let IndependentLoroDoc: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
  ({ LoroDoc: IndependentLoroDoc } = await import(
    "../../../independent-client/node_modules/loro-crdt/nodejs/index.js"
  ));
});

/** Values a field of a reply may hold, well-formed or not. */
const VALUES: unknown[] = [
  "bob",
  "",
  "é😀",
  0,
  1.5,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1_700_000_000_000,
  true,
  null,
  new Uint8Array([1, 2]),
  ["a"],
  { a: 1 },
];

/** Per field, the values D-39 tells apart. */
const TYPICAL: Record<string, unknown[]> = {
  author: [undefined, "", "bob", 3, null],
  createdAt: [undefined, 0, -1.5, Number.NaN, Number.NEGATIVE_INFINITY, "1"],
  body: [undefined, "", " ", "x", 7, null],
  extra: [undefined, "unknown field"],
};

/** An element of `replies`: a reply as a client writes it, one with
 * fields drawn among `VALUES`, a plain value, or another container. */
function element(tc: hegel.TestCase, list: LoroList): void {
  switch (
    tc.draw(gs.sampledFrom(["reply", "fields", "value", "list", "text"]))
  ) {
    case "value":
      list.push(tc.draw(gs.sampledFrom(VALUES)) as never);
      return;
    case "list":
      list.insertContainer(list.length, new LoroList());
      return;
    case "text":
      list.insertContainer(list.length, new LoroText()).insert(0, "t");
      return;
    default: {
      const reply = list.insertContainer(list.length, new LoroMap());
      const fields: Record<string, unknown> = {
        author: "bob",
        createdAt: 1,
        body: "hi",
      };
      // A valid reply, then zero to two fields drawn among their typical
      // values, or any value: drawn independently, one wrong field among
      // valid ones would be rare.
      for (let i = tc.draw(gs.integers({ minValue: 0, maxValue: 2 })); i; i--) {
        const field = tc.draw(gs.sampledFrom(Object.keys(TYPICAL)));
        fields[field] = tc.draw(
          gs.sampledFrom(
            tc.draw(gs.booleans()) ? (TYPICAL[field] ?? []) : VALUES,
          ),
        );
      }
      for (const [field, value] of Object.entries(fields)) {
        if (value !== undefined) reply.set(field, value as never);
      }
    }
  }
}

/** What both clients read of the entries: every field, the thread too. */
function official(content: LoroDoc, annotations: LoroDoc) {
  return listAnnotations(content, annotations).map((a) => ({
    id: a.id,
    type: a.type,
    author: a.author,
    status: a.status,
    createdAt: a.createdAt,
    body: a.body,
    range: a.range,
    // D-38's fields: a reply's `id` and `sig` (06-identity.md, ID-10)
    // are read by the signature checks.
    replies: a.replies.map(({ author, createdAt, body }) => ({
      author,
      createdAt,
      body,
    })),
  }));
}

function theirs(content: Uint8Array, annotations: Uint8Array) {
  const c = new IndependentLoroDoc();
  c.import(content);
  const a = new IndependentLoroDoc();
  a.import(annotations);
  return (
    independent.listAnnotations(a, c) as {
      id: string;
      type: string;
      author: string;
      status: string;
      createdAt: number;
      body?: string;
      range: unknown;
      replies: unknown;
    }[]
  ).map((x) => ({
    id: x.id,
    type: x.type,
    author: x.author,
    status: x.status,
    createdAt: x.createdAt,
    body: x.body,
    range: x.range,
    replies: x.replies,
  }));
}

describe("replies, official and independent clients, property", () => {
  test(
    "any thread, concurrent replies included: the same replies, in the same order",
    () =>
      hegel.test(
        (tc) => {
          const content = new LoroDoc();
          content.getText("content").insert(0, "hello world");
          content.commit();
          const annotations = new LoroDoc();
          const id = createAnnotation(content, annotations, {
            type: "comment",
            start: 0,
            end: 5,
            author: "alice",
            body: "c",
          });
          const peers = [annotations];
          for (
            let i = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
            i;
            i--
          ) {
            const peer = new LoroDoc();
            peer.import(annotations.export({ mode: "snapshot" }));
            peers.push(peer);
          }
          const entry = (doc: LoroDoc) =>
            doc.getMap("annotations").get(id) as LoroMap;
          const acts = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
          for (let i = 0; i < acts; i++) {
            const doc = tc.draw(gs.sampledFrom(peers));
            switch (
              tc.draw(
                gs.sampledFrom([
                  "reply",
                  "reply",
                  "element",
                  "element",
                  "replace",
                  "absent",
                ]),
              )
            ) {
              case "reply":
                replyToAnnotation(doc, id, {
                  author: tc.draw(gs.sampledFrom(["bob", "carol", ""])),
                  body: tc.draw(gs.text({ minSize: 1, maxSize: 4 })),
                  createdAt: tc.draw(gs.integers({ minValue: 0, maxValue: 9 })),
                });
                break;
              case "element": {
                const list = entry(doc).get("replies");
                if (list instanceof LoroList) element(tc, list);
                break;
              }
              case "replace":
                // A `replies` of another type, or a new list.
                switch (
                  tc.draw(gs.sampledFrom(["map", "text", "value", "list"]))
                ) {
                  case "map":
                    entry(doc).setContainer("replies", new LoroMap());
                    break;
                  case "text":
                    entry(doc).setContainer("replies", new LoroText());
                    break;
                  case "value":
                    entry(doc).set(
                      "replies",
                      tc.draw(gs.sampledFrom(VALUES)) as never,
                    );
                    break;
                  default:
                    entry(doc).setContainer("replies", new LoroList());
                }
                break;
              default:
                entry(doc).delete("replies");
            }
            doc.commit();
          }
          for (const peer of peers.slice(1)) {
            annotations.import(peer.export({ mode: "update" }));
          }

          expect(
            theirs(
              content.export({ mode: "snapshot" }),
              annotations.export({ mode: "snapshot" }),
            ),
          ).toEqual(official(content, annotations));
        },
        { testCases: 1000 },
      ),
    60_000,
  );
});
