import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, type PeerID } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type ChannelState,
  freezeIfPending,
  persistChannel,
  restoreChannel,
  storedCursor,
} from "./channel-state.js";

/** A content document holding `counts[i]` operations of peer `i + 1`; the
 * page's own peer is the last one. */
function docWith(counts: number[]): LoroDoc {
  const doc = new LoroDoc();
  counts.forEach((count, index) => {
    const writer = new LoroDoc();
    writer.setPeerId(BigInt(index + 1));
    writer.getText("content").insert(0, "x".repeat(count));
    writer.commit();
    doc.import(writer.export({ mode: "update" }));
  });
  doc.setPeerId(BigInt(counts.length + 1));
  return doc;
}

describe("channel state", () => {
  test("a fresh channel has nothing acked, nothing adopted, and the page's peer as its own", () => {
    const doc = docWith([]);
    const runtime = restoreChannel("content", doc, undefined);

    expect([...runtime.ownPeers]).toEqual([doc.peerIdStr]);
    expect(runtime.confirmedSeq).toBe(0);
    expect(runtime.adopted).toEqual([]);
    expect(persistChannel(runtime)).toEqual({
      channel: "content",
      cursor: 0,
      own: [],
      adopted: [],
    });
  });

  // ADR-0022, R-L1: what a later page resumes from is what this one would
  // store again — nothing gained, nothing lost, a peer fully acked left out.
  test("restoring what was persisted persists the same again", () =>
    hegel.test(
      (tc) => {
        const counts = Array.from(
          { length: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) },
          () => tc.draw(gs.integers({ minValue: 1, maxValue: 5 })),
        );
        const doc = docWith(counts);
        const own = counts.flatMap((count, index) =>
          tc.draw(gs.booleans())
            ? [
                {
                  peer: `${index + 1}`,
                  acked: tc.draw(gs.integers({ minValue: 0, maxValue: count })),
                },
              ]
            : [],
        );
        const adopted = Array.from(
          { length: tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) },
          () => ({
            change: new Uint8Array(
              tc.draw(gs.binary({ minSize: 1, maxSize: 4 })),
            ),
            ownBefore: own.map(({ peer, acked }) => ({ peer, counter: acked })),
          }),
        );
        const stored: ChannelState = {
          channel: "content",
          cursor: tc.draw(gs.integers({ minValue: 0, maxValue: 50 })),
          own,
          adopted,
        };

        const first = persistChannel(restoreChannel("content", doc, stored));
        const second = persistChannel(restoreChannel("content", doc, first));

        expect(second).toEqual(first);
        expect(first.cursor).toBe(stored.cursor);
        expect(first.adopted).toEqual(adopted);
        // Only what isn't all acked, at the counter the server acked.
        expect(first.own).toEqual(
          own.filter(
            ({ peer, acked }) => acked < (counts[Number(peer) - 1] ?? 0),
          ),
        );
      },
      { testCases: 200 },
    ));

  // R-L3: while an import waits for a dependency, the cursor stored is the
  // one from before that import; once nothing waits, the confirmed seq.
  test("a cursor frozen while operations wait is stored until they arrive", () => {
    const doc = docWith([]);
    const runtime = restoreChannel("content", doc, undefined);
    runtime.confirmedSeq = 7;

    freezeIfPending(runtime, 7);
    expect(runtime.frozenCursor).toBeUndefined(); // nothing waits

    runtime.pending.set("99" as PeerID, 1);
    freezeIfPending(runtime, 7);
    runtime.confirmedSeq = 12;
    freezeIfPending(runtime, 12); // the first wait still holds
    expect(storedCursor(runtime)).toBe(7);

    const writer = new LoroDoc();
    writer.setPeerId(99n);
    writer.getText("content").insert(0, "y");
    writer.commit();
    doc.import(writer.export({ mode: "update" }));
    expect(storedCursor(runtime)).toBe(12);
    expect(runtime.frozenCursor).toBeUndefined();
  });
});
