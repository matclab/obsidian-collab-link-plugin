import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { DecisionLog, type Proposal, encodeProposal } from "./decisions.js";

const ANNOTATIONS = ["a", "b", "c"];

/** Changes whose op ids overlap one another, as colliding suggestions
 * would: two peers, counters from 0, different lengths. */
const CHANGES = [1n, 1n, 2n].flatMap((peer, i) =>
  ["x", "xy", "xyz"].map((text) => {
    const doc = new LoroDoc();
    doc.setPeerId(peer);
    doc.getText("content").insert(0, `${i}${text}`);
    doc.commit();
    return doc.export({ mode: "update" });
  }),
);

function drawJournal(tc: TestCase): Uint8Array[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
  const journal: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    // A copy of an earlier record: a send retried after a lost ack.
    if (journal.length > 0 && tc.draw(gs.booleans())) {
      journal.push(tc.draw(gs.sampledFrom(journal)));
      continue;
    }
    const decision = tc.draw(
      gs.sampledFrom(["accept", "reject", "resolve"] as const),
    );
    const proposal: Proposal = {
      proposalId: `p${i}`,
      annotationId: tc.draw(gs.sampledFrom(ANNOTATIONS)),
      decision,
      author: "x",
      ...(decision === "accept" &&
        tc.draw(gs.booleans()) && {
          change: tc.draw(gs.sampledFrom(CHANGES)),
        }),
    };
    journal.push(encodeProposal(proposal));
  }
  return journal;
}

/** Feeds `journal[0..upTo)` to a fresh log, cut into random batches. */
function confirm(tc: TestCase, journal: Uint8Array[], upTo: number) {
  const log = new DecisionLog();
  let next = 0;
  while (next < upTo) {
    const size = tc.draw(gs.integers({ minValue: 1, maxValue: upTo - next }));
    log.add(
      journal
        .slice(next, next + size)
        .map((record, i) => ({ seq: next + i + 1, record })),
    );
    next += size;
  }
  return log;
}

function winners(log: DecisionLog) {
  // Per annotation: its decision (void or not), then its resolution.
  return ANNOTATIONS.flatMap((id) => {
    const winner = log.winner(id);
    const resolution = log.resolution(id);
    return [
      winner &&
        `${winner.proposalId}:${winner.decision}${winner.void ? ":void" : ""}`,
      resolution?.proposalId,
    ];
  });
}

describe("DecisionLog property tests", () => {
  test("the winners only depend on the confirmed prefix, not on how it was batched", () =>
    hegel.test((tc) => {
      const journal = drawJournal(tc);
      const a = winners(confirm(tc, journal, journal.length));
      const b = winners(confirm(tc, journal, journal.length));
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`batching changed the winners: ${a} vs ${b}`);
      }
    }));

  test("confirming more of the journal never changes a decision already made", () =>
    hegel.test((tc) => {
      const journal = drawJournal(tc);
      const cut = tc.draw(
        gs.integers({ minValue: 0, maxValue: journal.length }),
      );
      const before = winners(confirm(tc, journal, cut));
      const after = winners(confirm(tc, journal, journal.length));
      before.forEach((winner, i) => {
        if (winner !== undefined && winner !== after[i]) {
          throw new Error(
            `a later or duplicated proposal changed ${ANNOTATIONS[Math.floor(i / 2)]}: ${winner} -> ${after[i]}`,
          );
        }
      });
    }));
});
