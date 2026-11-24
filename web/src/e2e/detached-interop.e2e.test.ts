// @vitest-environment node
//
// C6 (docs/security/untrusted-inputs.md): a detached change is written by
// any reviewer and checked by every editor, which must reach the same
// verdict whatever its own state, or one shows and accepts a suggestion
// another refuses (D-17). The official check against the independent
// client's (written from the specification alone, on Loro 1.16.3), on
// changes a reviewer could forge, each checked by an editor that edited
// on its own since and by one that did not. Found missing when the
// official client's own property hit two verdicts for one change (phase
// 11e): Loro's JSON gave one insertion as one operation in one copy, as
// two in the other.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, test } from "vitest";
import {
  checkDetachedChange,
  createDetachedChange,
  suggestionPeer,
} from "../../lib/src/annotations/detached.js";
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

const ANNOTATION = "a1";
// UTF-16 offsets below never split a surrogate pair: Loro refuses that.
const BMP = { maxCodepoint: 0xd7ff };

/** What a reviewer can put in a change: insertions (often each right
 * after the last: one insertion, D-17 rule 3), deletions, other
 * containers, commits in between. */
function forge(tc: hegel.TestCase, doc: LoroDoc): Uint8Array {
  if (tc.draw(gs.booleans()))
    return createDetachedChange(
      doc,
      ANNOTATION,
      tc.draw(
        gs.integers({ minValue: 0, maxValue: doc.getText("content").length }),
      ),
      tc.draw(gs.text({ ...BMP, minSize: 1, maxSize: 4 })),
    );
  const fork = doc.fork();
  fork.setPeerId(suggestionPeer(ANNOTATION));
  const text = fork.getText("content");
  let end = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  for (let step = 0; step < steps; step++) {
    const piece = tc.draw(gs.text({ ...BMP, minSize: 1, maxSize: 3 }));
    switch (
      tc.draw(
        gs.sampledFrom([
          "append",
          "append",
          "insert",
          "delete",
          "other",
          "commit",
          "foreign",
        ]),
      )
    ) {
      case "append":
        text.insert(end, piece);
        end += piece.length;
        break;
      case "insert":
        end = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
        text.insert(end, piece);
        end += piece.length;
        break;
      case "delete":
        if (text.length > 0) text.delete(0, 1);
        end = Math.min(end, text.length);
        break;
      case "other":
        fork.getText("other").insert(0, piece);
        break;
      case "foreign": {
        // The editor writes, the reviewer imports it and puts a piece where
        // its last one ended as read before: positions that look end to
        // end on two states (the security review's forgery, D-17 rule 3).
        const from = doc.oplogVersion();
        doc.getText("content").insert(0, "Z");
        doc.commit();
        fork.import(doc.export({ mode: "update", from }));
        text.insert(Math.min(end, text.length), piece);
        end += piece.length;
        break;
      }
      default:
        fork.commit();
    }
  }
  fork.commit();
  // Only the reviewer's operations: from the editor's version.
  const change = fork.export({ mode: "update", from: doc.oplogVersion() });
  fork.free();
  return change;
}

const official = (doc: LoroDoc, change: Uint8Array): string => {
  const verdict = checkDetachedChange(doc, ANNOTATION, change);
  return verdict.kind;
};

describe("detached changes: the official and the independent client (property)", () => {
  test(
    "one verdict for a change, in either client, whether the editor edited on its own since or not",
    () =>
      hegel.testAsync(
        async (tc) => {
          const e1 = new LoroDoc();
          e1.setPeerId(1);
          e1.getText("content").insert(
            0,
            tc.draw(gs.text({ ...BMP, minSize: 1, maxSize: 20 })),
          );
          e1.commit();
          const e2 = new LoroDoc();
          e2.setPeerId(3);
          e2.import(e1.export({ mode: "snapshot" }));
          const change = forge(tc, e1);
          // What e1 wrote while the reviewer forged, e2 has too.
          e2.import(e1.export({ mode: "update", from: e2.oplogVersion() }));
          // e1 edits on its own before checking.
          const t1 = e1.getText("content");
          t1.delete(
            0,
            tc.draw(gs.integers({ minValue: 0, maxValue: t1.length })),
          );
          t1.insert(0, tc.draw(gs.text({ ...BMP, maxSize: 4 })));
          e1.commit();
          const verdicts: string[] = [];
          for (const doc of [e1, e2]) {
            verdicts.push(`official ${official(doc, change)}`);
            const copy = new IndependentLoroDoc();
            copy.import(doc.export({ mode: "snapshot" }));
            verdicts.push(
              `independent ${await independent.checkChange(copy, ANNOTATION, change)}`,
            );
          }
          const kinds = new Set(verdicts.map((v) => v.split(" ")[1]));
          if (kinds.size !== 1)
            throw new Error(`verdicts differ: ${verdicts.join(", ")}`);
        },
        { testCases: 400 },
      ),
    120_000,
  );
});
