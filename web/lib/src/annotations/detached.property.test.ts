import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import {
  checkDetachedChange,
  createDetachedChange,
  suggestionPeer,
} from "./detached.js";

type Edit =
  | { kind: "insert"; at: number; text: string }
  | { kind: "delete"; at: number; length: number }
  | { kind: "other-text" }
  | { kind: "map" }
  | { kind: "mark" }
  | { kind: "commit" }
  /** The checking editor writes; the reviewer imports it and, if `text`,
   * at once puts a piece where its last one ended as it read it before —
   * a composed gesture: positions that look end to end on two states. */
  | { kind: "foreign"; text: string };

const ANNOTATION = "a1";
// UTF-16 offsets below never split a surrogate pair: Loro refuses that.
const BMP = { maxCodepoint: 0xd7ff };

function base(tc: TestCase): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  doc
    .getText("content")
    .insert(0, tc.draw(gs.text({ ...BMP, minSize: 1, maxSize: 20 })));
  doc.commit();
  return doc;
}

function drawEdit(tc: TestCase, length: number): Edit {
  const kind = tc.draw(
    gs.sampledFrom([
      "insert",
      "insert",
      "delete",
      "other-text",
      "map",
      "mark",
      "commit",
      "foreign",
    ] as const),
  );
  switch (kind) {
    case "insert":
      return {
        kind,
        at: tc.draw(gs.integers({ minValue: 0, maxValue: length })),
        text: tc.draw(gs.text({ ...BMP, maxSize: 6 })),
      };
    case "delete": {
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: length }));
      return {
        kind,
        at,
        length: tc.draw(gs.integers({ minValue: 0, maxValue: length - at })),
      };
    }
    case "foreign":
      return { kind, text: tc.draw(gs.text({ ...BMP, maxSize: 3 })) };
    default:
      return { kind };
  }
}

/** Builds whatever a reviewer could put in an annotation: `edits` on a
 * fork of `doc`, as `peer`. Returns the change and what ADR-0018 says of
 * it. `run`: the text, when the edits are only insertions into `content`
 * each appended right after the previous one, by the annotation's peer —
 * one contiguous insertion, the only thing that may be valid. A run is
 * one insertion, however Loro gives it
 * back (one operation or several, depending on the checking editor's doc:
 * D-17, rule 3): it must be valid. */
function forge(doc: LoroDoc, peer: bigint, edits: Edit[]) {
  const fork = doc.fork();
  fork.setPeerId(peer);
  fork.configTextStyle({ bold: { expand: "after" } });
  const text = fork.getText("content");
  let ops = 0;
  let inserts = 0;
  let run: { at: number; text: string } | undefined;
  // The editor wrote, and the reviewer imported it, after a first piece.
  let seen = false;
  for (const edit of edits) {
    switch (edit.kind) {
      case "insert": {
        if (edit.text.length === 0) break; // Loro records nothing
        const at = Math.min(edit.at, text.length);
        text.insert(at, edit.text);
        if (seen) run = undefined;
        else if (inserts === 0) run = { at, text: edit.text };
        else if (run && at === run.at + run.text.length) run.text += edit.text;
        else run = undefined;
        inserts++;
        ops++;
        break;
      }
      case "delete": {
        const at = Math.min(edit.at, text.length);
        const length = Math.min(edit.length, text.length - at);
        if (length === 0) break;
        text.delete(at, length);
        ops += 2; // never the single insertion
        break;
      }
      case "other-text":
        fork.getText("other").insert(0, "x");
        ops += 2;
        break;
      case "map":
        fork.getMap("m").set("k", 1);
        ops += 2;
        break;
      case "mark":
        if (text.length === 0) break;
        text.mark({ start: 0, end: 1 }, "bold", true);
        ops += 2;
        break;
      case "commit":
        fork.commit();
        break;
      case "foreign": {
        // Not as the editor's own peer: the ids would collide.
        if (peer === 1n) break;
        const from = doc.oplogVersion();
        doc.getText("content").insert(0, "Z");
        doc.commit();
        fork.import(doc.export({ mode: "update", from }));
        // A piece after this is positioned on a state the pieces before
        // it did not see: no longer one insertion (D-17, rule 3).
        if (inserts > 0) seen = true;
        if (run && edit.text.length > 0) {
          // Where the last piece ended, read before the import.
          text.insert(
            Math.min(run.at + run.text.length, text.length),
            edit.text,
          );
          inserts++;
          ops++;
          run = undefined;
        }
        break;
      }
    }
  }
  fork.commit();
  // Only the reviewer's operations: from the editor's version.
  const change = fork.export({ mode: "update", from: doc.oplogVersion() });
  fork.free();
  const ours = peer === suggestionPeer(ANNOTATION) && ops === inserts;
  return {
    change,
    run: ours ? run?.text : undefined,
    empty: ops === 0,
  };
}

describe("detached change property tests", () => {
  test(
    "a change is valid only as one contiguous insertion by the annotation's peer, and always so for one insertion",
    () =>
      hegel.test(
        (tc) => {
          const doc = base(tc);
          const edits = tc.draw(
            gs.arrays(
              gs.composite((t) => drawEdit(t, doc.getText("content").length)),
              { maxSize: 4 },
            ),
          );
          const peer = tc.draw(
            gs.sampledFrom([suggestionPeer(ANNOTATION), 1n, 77n]),
          );
          const { change, run, empty } = forge(doc, peer, edits);
          if (empty) return; // nothing exported
          const before = doc.getText("content").toString();
          const verdict = checkDetachedChange(doc, ANNOTATION, change);
          if (doc.getText("content").toString() !== before) {
            throw new Error("checking changed the editor's doc");
          }
          const fail = (why: string) =>
            new Error(
              `edits ${JSON.stringify(edits)} as ${peer}: ${why}, got ${JSON.stringify(verdict)}`,
            );
          if (verdict.kind === "valid" && verdict.text !== run) {
            throw fail(`only ${JSON.stringify(run)} may be valid`);
          }
          if (run !== undefined && verdict.kind !== "valid")
            throw fail("a run of appends is one insertion");
          // More cases than the default: the composed gesture after a first
          // piece (a forgery the security review found) needs them.
        },
        { testCases: 1000 },
      ),
    60_000,
  );

  test("two editors in different states reach the same verdict", () =>
    hegel.test((tc) => {
      const doc = base(tc);
      const e2 = new LoroDoc();
      e2.setPeerId(3);
      e2.import(doc.export({ mode: "snapshot" }));
      const edits = tc.draw(
        gs.arrays(
          gs.composite((t) => drawEdit(t, doc.getText("content").length)),
          { minSize: 1, maxSize: 3 },
        ),
      );
      const honest = tc.draw(gs.booleans());
      const change = honest
        ? createDetachedChange(doc, ANNOTATION, 0, "x")
        : forge(doc, suggestionPeer(ANNOTATION), edits).change;
      // What the editor wrote while the reviewer forged, e2 has too.
      e2.import(doc.export({ mode: "update", from: e2.oplogVersion() }));
      // e1 edits content on its own before checking (deleting what the
      // change may delete too).
      const t1 = doc.getText("content");
      const cut = tc.draw(gs.integers({ minValue: 0, maxValue: t1.length }));
      t1.delete(0, cut);
      t1.insert(0, tc.draw(gs.text({ ...BMP, maxSize: 4 })));
      doc.commit();
      const v1 = checkDetachedChange(doc, ANNOTATION, change);
      const v2 = checkDetachedChange(e2, ANNOTATION, change);
      const same = (v: typeof v1) =>
        v.kind === "valid" ? `valid:${v.text}` : v.kind;
      if (same(v1) !== same(v2)) {
        throw new Error(
          `verdicts differ: ${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`,
        );
      }
    }));
});
