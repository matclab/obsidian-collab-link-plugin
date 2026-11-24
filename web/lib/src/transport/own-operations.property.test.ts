import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, type PeerID } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { restoreChannel } from "./channel-state.js";
import { type Span, fitting, markAcked, ownSpans } from "./own-operations.js";
import { FRAME_OVERHEAD } from "./protocol.js";

/** A content document where earlier pages (peers 1..n) and this page (peer
 * n + 1, typing after importing them) wrote, each `counts[i]` characters. */
function written(counts: number[]): LoroDoc {
  const doc = new LoroDoc();
  counts.slice(0, -1).forEach((count, index) => {
    const writer = new LoroDoc();
    writer.setPeerId(BigInt(index + 1));
    writer.getText("content").insert(0, "e".repeat(count));
    writer.commit();
    doc.import(writer.export({ mode: "update" }));
  });
  doc.setPeerId(BigInt(counts.length));
  const typed = counts.at(-1) ?? 0;
  for (let i = 0; i < typed; i++) doc.getText("content").insert(0, "t");
  doc.commit();
  return doc;
}

/** Every counter a list of spans covers, as `peer:counter`. */
function counters(spans: Span[]): string[] {
  return spans.flatMap(({ id, len }) =>
    Array.from({ length: len }, (_, i) => `${id.peer}:${id.counter + i}`),
  );
}

describe("own operations property tests", () => {
  // ADR-0015, R-A1, R-L1, O-18: published frame after frame, each acked,
  // a client's frames cover exactly its own operations not acked yet, each
  // once, earlier pages' before this page's, and each frame fits — unless
  // it holds a single operation, which no frame could.
  test("frame after frame, exactly the own operations not acked, in order, each frame fitting", () =>
    hegel.test(
      (tc) => {
        const counts = Array.from(
          { length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) },
          () => tc.draw(gs.integers({ minValue: 0, maxValue: 30 })),
        );
        const doc = written(counts);
        const own = counts.map((count, index) => ({
          peer: `${index + 1}`,
          acked: tc.draw(gs.integers({ minValue: 0, maxValue: count })),
        }));
        const runtime = restoreChannel("content", doc, {
          channel: "content",
          cursor: 0,
          own,
          adopted: [],
        });
        const maxMessageBytes =
          FRAME_OVERHEAD + tc.draw(gs.integers({ minValue: 1, maxValue: 600 }));

        const expected = own.flatMap(({ peer, acked }) =>
          Array.from(
            { length: (counts[Number(peer) - 1] ?? 0) - acked },
            (_, i) => `${peer}:${acked + i}`,
          ),
        );
        const published: string[] = [];
        for (let frames = 0; ; frames++) {
          if (frames > 1000) throw new Error("publishing never ends");
          const spans = ownSpans(runtime, undefined);
          if (spans.length === 0) break;
          // This page's peer last.
          const last = spans.findIndex((s) => s.id.peer === doc.peerIdStr);
          expect(last === -1 || last === spans.length - 1).toBe(true);

          const { sent, update } = fitting(doc, spans, maxMessageBytes);
          const size = sent.reduce((sum, { len }) => sum + len, 0);
          expect(size).toBeGreaterThan(0);
          expect(
            FRAME_OVERHEAD + update.length <= maxMessageBytes || size === 1,
          ).toBe(true);
          // A prefix of what was asked.
          expect(counters(spans).slice(0, size)).toEqual(counters(sent));

          expect(markAcked(runtime, sent)).toBe(size);
          published.push(...counters(sent));
        }
        expect(published.sort()).toEqual(expected.sort());
      },
      { testCases: 200 },
    ));

  // R-A1: before an adopted change, only what was typed before it.
  test("with an adoption at the head, only the own operations from before it", () =>
    hegel.test(
      (tc) => {
        const before = tc.draw(gs.integers({ minValue: 0, maxValue: 10 }));
        const after = tc.draw(gs.integers({ minValue: 0, maxValue: 10 }));
        const doc = written([before]);
        const runtime = restoreChannel("content", doc, undefined);
        const peer = doc.peerIdStr;
        const head = {
          change: new Uint8Array([1]),
          ownBefore: new Map<PeerID, number>([[peer, before]]),
        };
        for (let i = 0; i < after; i++) doc.getText("content").insert(0, "a");
        doc.commit();

        const spans = ownSpans(runtime, head);

        expect(counters(spans)).toEqual(
          Array.from({ length: before }, (_, i) => `${peer}:${i}`),
        );
      },
      { testCases: 100 },
    ));
});
