import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { confirmedBatch, groupReply } from "./history-reply.js";

describe("decisions replies property tests", () => {
  // DecisionsConnection's contract: whatever order replies end decrypting
  // in, the batches delivered are sorted, never repeat a seq, never skip
  // one — a gapless prefix of the journal. Each reply is the whole suffix
  // of the journal after its `since`, the cursor when its join was sent:
  // so never past the cursor when it is delivered.
  test("replies delivered in any order confirm a gapless prefix, each seq once", () =>
    hegel.test(
      (tc) => {
        let journal = 0;
        let cursor = 0;
        const inFlight: { seq: number; record: Uint8Array }[][] = [];
        const delivered: number[] = [];
        const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
        for (let i = 0; i < steps; i++) {
          const act = tc.draw(gs.sampledFrom(["journal", "join", "deliver"]));
          if (act === "journal") journal++;
          else if (act === "join") {
            // Replied at once, decrypted later; entries in any order.
            const entries = Array.from(
              { length: journal - cursor },
              (_, k) => ({
                seq: cursor + k + 1,
                record: new Uint8Array([cursor + k + 1]),
              }),
            );
            if (tc.draw(gs.booleans())) entries.reverse();
            inFlight.push(entries);
          } else if (inFlight.length > 0) {
            const index = tc.draw(
              gs.integers({ minValue: 0, maxValue: inFlight.length - 1 }),
            );
            const [reply] = inFlight.splice(index, 1);
            const { batch, cursor: next } = confirmedBatch(reply ?? [], cursor);
            expect(batch.map(({ seq }) => seq)).toEqual(
              Array.from({ length: next - cursor }, (_, k) => cursor + k + 1),
            );
            delivered.push(...batch.map(({ seq }) => seq));
            cursor = next;
          }
        }
        expect(delivered).toEqual(
          Array.from({ length: delivered.length }, (_, k) => k + 1),
        );
      },
      { testCases: 300 },
    ));
});

describe("groupReply", () => {
  test("groups a reply by channel, in the connection's order, with each one's highest seq", () => {
    const content = { name: "content" };
    const annotations = { name: "annotations" };
    const unread = undefined;
    const groups = groupReply(
      [
        { runtime: annotations, seq: 4, plaintext: new Uint8Array([4]) },
        { runtime: content, seq: 2, plaintext: new Uint8Array([2]) },
        { runtime: content, seq: 5, plaintext: unread },
        { runtime: annotations, seq: 6, plaintext: new Uint8Array([6]) },
      ],
      [content, annotations, { name: "silent" }],
    );

    // An entry that couldn't be read still moves the cursor (decision 10).
    expect(groups).toEqual([
      { runtime: content, updates: [new Uint8Array([2])], seq: 5 },
      {
        runtime: annotations,
        updates: [new Uint8Array([4]), new Uint8Array([6])],
        seq: 6,
      },
    ]);
  });
});
