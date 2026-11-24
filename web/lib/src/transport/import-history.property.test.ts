import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, test } from "vitest";
import { importHistory } from "./import-history.js";

/** A journal as the server may hold it: the local updates of a few peers,
 * each journaled once or twice (a retried publish), and optionally
 * compacted — every entry up to a point replaced by a shallow snapshot
 * of a peer that had seen them all. */
function drawJournal(tc: hegel.TestCase): Uint8Array[] {
  let latest: Uint8Array | undefined;
  const peers = [1n, 2n, 3n].map((id) => {
    const doc = new LoroDoc();
    doc.setPeerId(id);
    doc.subscribeLocalUpdates((update) => {
      latest = update;
    });
    return doc;
  });
  const journal: Uint8Array[] = [];
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
  let compactAt: number | undefined;
  let snapshot: Uint8Array | undefined;
  for (let i = 0; i < steps; i++) {
    const peer = tc.draw(gs.sampledFrom(peers));
    const text = peer.getText("content");
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
    text.insert(
      at,
      tc.draw(gs.text({ minSize: 1, maxSize: 3, alphabet: "ab" })),
    );
    if (tc.draw(gs.booleans())) {
      peer
        .getMap("annotations")
        .setContainer(`a${i}`, new LoroMap())
        .set("status", "open");
    }
    peer.commit();
    const fresh = latest;
    if (!fresh) throw new Error("a commit publishes an update");
    journal.push(fresh);
    if (tc.draw(gs.booleans())) journal.push(fresh); // retried after a lost ack
    // Peers learn what's journaled, in journal order.
    for (const other of peers) if (other !== peer) other.import(fresh);
    if (compactAt === undefined && tc.draw(gs.booleans())) {
      compactAt = journal.length;
      snapshot = peer.export({
        mode: "shallow-snapshot",
        frontiers: peer.oplogFrontiers(),
      });
    }
  }
  if (compactAt === undefined || !snapshot) return journal;
  return [snapshot, ...journal.slice(compactAt)];
}

const state = (doc: LoroDoc) => JSON.stringify(doc.toJSON());

describe("importHistory", () => {
  test(
    "reaches the same state as importing entry by entry, compacted or not",
    () =>
      hegel.test((tc) => {
        const journal = drawJournal(tc);
        const oneByOne = new LoroDoc();
        for (const update of journal) oneByOne.import(update);
        const batched = new LoroDoc();
        importHistory(batched, journal);
        if (state(batched) !== state(oneByOne)) {
          throw new Error(
            `batched ${state(batched)} != one by one ${state(oneByOne)}`,
          );
        }
      }),
    // Under 0.5 s alone; the whole suite's parallel workers slow it past
    // vitest's 5 s, as for the other properties.
    60_000,
  );
});

describe("importHistory with invalid entries (decision 10)", () => {
  test(
    "skips and reports each, and reaches the state of the valid entries alone",
    () =>
      hegel.test((tc) => {
        const journal = drawJournal(tc);
        const withInvalid = [...journal];
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
        for (let i = 0; i < count; i++) {
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: withInvalid.length }),
          );
          const source = journal[
            tc.draw(gs.integers({ minValue: 0, maxValue: journal.length - 1 }))
          ] as Uint8Array;
          const invalid = tc.draw(gs.booleans())
            ? new Uint8Array(tc.draw(gs.binary({ minSize: 0, maxSize: 64 })))
            : // a real header, a truncated body
              source.slice(0, Math.max(1, source.length - 4));
          withInvalid.splice(at, 0, invalid);
        }
        const expected = new LoroDoc();
        importHistory(expected, journal);
        const doc = new LoroDoc();
        let reported = 0;
        importHistory(doc, withInvalid, new Map(), () => reported++);
        if (state(doc) !== state(expected)) {
          throw new Error(`${state(doc)} != valid alone ${state(expected)}`);
        }
        if (reported !== count) {
          throw new Error(`${reported} reported, ${count} inserted`);
        }
      }),
    60_000,
  );
});
