// @vitest-environment node
//
// Phase 9, 9c.3 (C7): decision records are written by any editor and read
// by every client, which must agree on each record's validity and on the
// winners, or their statuses diverge for good (D-21 to D-27). The official
// decoder against the independent client's (written from the
// specification alone, on Loro 1.16.3), on hostile records: none throws,
// both reach the same verdict and the same winners.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeAll, describe, expect, test } from "vitest";
import { DecisionLog, decodeProposal } from "../../lib/src/index.js";
import { fromHex, vectors } from "../../lib/src/test-support/vectors.js";
import { linkIndependentLoro } from "./independent-loro.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
});

const { document } = vectors;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

/** Detached changes from the vectors (valid, of another peer, not Loro…),
 * and the same changes mutated: what `change` may carry. */
const changes: Uint8Array[] = document.detached_changes.map(
  ({ change }: { change: string }) => fromHex(change),
);

/** Bytes changed the way a hostile or broken writer could: a byte
 * flipped, inserted, removed, or the end cut off. */
function mutated(tc: TC, bytes: Uint8Array): Uint8Array {
  const out = [...bytes];
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
  for (let step = 0; step < steps; step++) {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: out.length }));
    const byte = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
    switch (tc.draw(gs.sampledFrom(["flip", "insert", "remove", "cut"]))) {
      case "flip":
        if (at < out.length) out[at] = (out[at] as number) ^ (1 << (byte % 8));
        break;
      case "insert":
        out.splice(at, 0, byte);
        break;
      case "remove":
        out.splice(at, 1);
        break;
      default:
        out.length = at;
    }
  }
  return Uint8Array.from(out);
}

function change(tc: TC): Uint8Array {
  const base = tc.draw(gs.sampledFrom(changes));
  // Mostly intact: two acceptances of the same operations must happen.
  return tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0
    ? mutated(tc, base)
    : base;
}

const KEYS = [
  "proposalId",
  "annotationId",
  "decision",
  "author",
  "change",
  "x",
  "__proto__",
];

/** A JSON value as text, among those the rules tell apart. */
function value(tc: TC, key: string): string {
  const quoted = (text: string) => JSON.stringify(text);
  const pool: (() => string)[] = [
    () =>
      tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
        ? quoted(tc.draw(gs.sampledFrom(["p1", "p2", "p3"])))
        : // Escapes D-22 tells apart, inside an otherwise fine string.
          tc.draw(
            gs.sampledFrom([
              '"p\\udc00"',
              '"p\\ud800"',
              '"\\ud800p"',
              '"\\ud800p\\udc00"',
              '"p\\ud83d\\ude00"',
              '"p\\ude00\\ud83d"',
              '"p\\\\udc00"',
              '"p\\\\\\udc00"',
            ]),
          ),
    () => quoted(tc.draw(gs.sampledFrom(["a1", "a2", "c1"]))),
    () => quoted(tc.draw(gs.sampledFrom(["accept", "reject", "resolve"]))),
    () => quoted(b64(change(tc))),
    () =>
      tc.draw(
        gs.sampledFrom([
          '""',
          "null",
          "1",
          "[]",
          "{}",
          "true",
          '"Accept"',
          '"\\u0061ccept"',
          '"\\ud800"',
          '"\\udc00"',
          '"\\ud83d\\ude00"',
          '"\\\\ud800"',
          '"\\ud800\\u0041"',
          '"QR=="',
          '"A==="',
          '"AQ"',
          '"AQI="',
          '"AQ=="',
          '"AQID\\n"',
          '"====" ',
        ]),
      ),
  ];
  // Mostly the value the key expects, so records are often valid.
  const expected = new Map([
    ["proposalId", 0],
    ["annotationId", 1],
    ["decision", 2],
    ["author", 0],
    ["change", 3],
  ]);
  if (key === "change") {
    const pick = tc.draw(gs.integers({ minValue: 0, maxValue: 7 }));
    if (pick === 0) return "null"; // not absent (D-24)
    if (pick === 1) return (pool[4] as () => string)();
  }
  const index = expected.get(key);
  if (
    index !== undefined &&
    tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
  ) {
    return (pool[index] as () => string)();
  }
  return (tc.draw(gs.sampledFrom(pool)) as () => string)();
}

/** A record as an editor could write it: the four fields, often a change,
 * sometimes a field missing, repeated, unknown, the whole wrapped in a
 * byte-order mark or whitespace, or its bytes mutated. */
function record(tc: TC): Uint8Array {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
  if (kind === 0) {
    const vector = tc.draw(gs.sampledFrom(document.decision_records)) as {
      plaintext: string;
    };
    return mutated(tc, fromHex(vector.plaintext));
  }
  const keys = ["proposalId", "annotationId", "decision", "author"].filter(
    () => tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) > 0,
  );
  if (tc.draw(gs.booleans())) keys.push("change");
  const extra = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  for (let i = 0; i < extra; i++) {
    const key = tc.draw(gs.sampledFrom(KEYS));
    keys.splice(
      tc.draw(gs.integers({ minValue: 0, maxValue: keys.length })),
      0,
      key,
    );
  }
  const members = keys.map((key) => `${JSON.stringify(key)}:${value(tc, key)}`);
  let text = `{${members.join(",")}}`;
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
    text = tc.draw(gs.sampledFrom([" \n", "\t", "[", "﻿"])) + text;
  }
  const bytes = utf8(text);
  return kind <= 2 ? mutated(tc, bytes) : bytes;
}

/** A journal's record: mostly a well-formed proposal on one of three
 * annotations — so that winners, and acceptances of operations an earlier
 * winner took, happen —, otherwise a hostile one. */
function journaled(tc: TC): Uint8Array {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) {
    return record(tc);
  }
  const decision = tc.draw(
    gs.sampledFrom(["accept", "accept", "reject", "resolve"]),
  );
  const withChange =
    decision === "accept" &&
    tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0;
  return utf8(
    JSON.stringify({
      proposalId: tc.draw(gs.sampledFrom(["p1", "p2", "p3"])),
      annotationId: tc.draw(gs.sampledFrom(["a1", "a2", "c1"])),
      decision,
      author: "ed",
      ...(withChange && {
        change: b64(
          tc.draw(gs.booleans()) ? (changes[0] as Uint8Array) : change(tc),
        ),
      }),
    }),
  );
}

/** A decoded record, comparable across both decoders. */
function comparable(
  decoded:
    | {
        proposalId: string;
        annotationId: string;
        decision: string;
        author: string;
        change?: Uint8Array;
      }
    | null
    | undefined,
) {
  if (!decoded) return null;
  const { proposalId, annotationId, decision, author, change } = decoded;
  return {
    proposalId,
    annotationId,
    decision,
    author,
    change: change === undefined ? null : hex(change),
  };
}

describe("decision records, official and independent decoders, property", () => {
  test(
    "a hostile record: neither throws, both reach the same verdict",
    () =>
      hegel.test(
        (tc) => {
          const bytes = record(tc);
          const official = decodeProposal(bytes);
          const theirs = independent.parseDecision(bytes);
          expect(comparable(official)).toEqual(comparable(theirs));
        },
        { testCases: 3000 },
      ),
    60_000,
  );

  test(
    "a hostile journal: the same winners, whatever the batches",
    () =>
      hegel.test(
        (tc) => {
          const length = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
          const journal: { seq: number; record: Uint8Array }[] = [];
          let seq = 0;
          for (let i = 0; i < length; i++) {
            seq += tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
            journal.push({ seq, record: journaled(tc) });
          }
          const log = new DecisionLog();
          for (let at = 0; at < journal.length; ) {
            const size = tc.draw(
              gs.integers({ minValue: 1, maxValue: journal.length - at }),
            );
            log.add(journal.slice(at, at + size));
            at += size;
          }
          const winners = new independent.Winners();
          for (const { seq, record } of journal) {
            winners.add(seq, independent.parseDecision(record));
          }
          for (const id of ["a1", "a2", "c1"]) {
            const ours = log.winner(id);
            const theirs = winners.suggestions.get(id);
            expect(
              ours && {
                proposalId: ours.proposalId,
                decision: ours.decision,
                seq: ours.seq,
                void: ours.void === true,
              },
            ).toEqual(
              theirs && {
                proposalId: theirs.proposalId,
                decision: theirs.decision,
                seq: theirs.seq,
                void: theirs.void,
              },
            );
            const resolution = log.resolution(id);
            const comment = winners.comments.get(id);
            expect(
              resolution && {
                proposalId: resolution.proposalId,
                seq: resolution.seq,
              },
            ).toEqual(
              comment && { proposalId: comment.proposalId, seq: comment.seq },
            );
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
