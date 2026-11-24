import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { createPeer, syncAll } from "../../lib/src/test-support/peers.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz .,!?-";

// Generalizes choice/loro/t7-interleaving-sanity/run.mjs: two peers
// concurrently insert distinct marker runs at the same position. Loro
// (Fugue) guarantees "maximal non-interleaving" — each peer's run must stay
// contiguous in the merged result, never split up with the other peer's
// characters mixed in.
describe("non-interleaving under concurrent same-position inserts (generalizes T7)", () => {
  test("two concurrent runs inserted at the same position stay contiguous after sync", () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(
        gs.text({ minSize: 0, maxSize: 20, alphabet: ALPHABET }),
      );
      const insertPos = tc.draw(
        gs.integers({ minValue: 0, maxValue: base.length }),
      );
      const runLengthA = tc.draw(gs.integers({ minValue: 2, maxValue: 15 }));
      const runLengthB = tc.draw(gs.integers({ minValue: 2, maxValue: 15 }));
      const runA = "A".repeat(runLengthA);
      const runB = "B".repeat(runLengthB);

      const author = createPeer();
      author.getText("doc").insert(0, base);

      const peerA = createPeer();
      const peerB = createPeer();
      syncAll([author, peerA, peerB]);

      peerA.getText("doc").insert(insertPos, runA);
      peerB.getText("doc").insert(insertPos, runB);

      syncAll([author, peerA, peerB]);

      const finalText = peerA.getText("doc").toString();
      const converged =
        finalText === peerB.getText("doc").toString() &&
        finalText === author.getText("doc").toString();
      if (!converged) {
        throw new Error(
          `peers diverged: ${JSON.stringify([finalText, peerB.getText("doc").toString()])}`,
        );
      }

      assertContiguousRun(finalText, "A", runLengthA);
      assertContiguousRun(finalText, "B", runLengthB);
    }));
});

// Checks that every occurrence of `marker` in `text` forms a single
// contiguous block of the expected length — stronger than `includes()`,
// which a short run could satisfy by coincidence inside an interleaved
// sequence (e.g. "AA" appearing inside "ABAABA").
function assertContiguousRun(
  text: string,
  marker: string,
  expectedLength: number,
): void {
  const indices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === marker) indices.push(i);
  }
  const first = indices[0];
  const last = indices[indices.length - 1];
  const contiguous =
    indices.length === expectedLength &&
    first !== undefined &&
    last === first + expectedLength - 1;
  if (!contiguous) {
    throw new Error(
      `run of "${marker}" was interleaved (not contiguous) in the merged text: ${JSON.stringify(text)}, indices=${JSON.stringify(indices)}`,
    );
  }
}
