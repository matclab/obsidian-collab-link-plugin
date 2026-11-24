import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  type LocalRecord,
  type StoredChannel,
  decodeRecord,
  encodeRecord,
} from "./record.js";

// Hegel draws Buffers; a record holds plain Uint8Arrays, as Loro gives.
const blob = gs
  .binary({ minSize: 0, maxSize: 64 })
  .map((bytes) => new Uint8Array(bytes));
const seq = gs.integers({ minValue: 0, maxValue: Number.MAX_SAFE_INTEGER });
// Loro peer ids: u64, in decimal.
const peer = gs
  .bigIntegers({ minValue: 0n, maxValue: 2n ** 64n - 1n })
  .map((n) => `${n}`);

describe("local record encoding, property", () => {
  test("decode(encode(r)) equals r", () =>
    hegel.test((tc) => {
      const peerCounters = () =>
        tc.draw(gs.arrays(gs.tuples(peer, seq), { maxSize: 4 }));
      const channel = (name: StoredChannel["channel"]): StoredChannel => ({
        channel: name,
        snapshot: tc.draw(blob),
        cursor: tc.draw(seq),
        own: peerCounters().map(([p, acked]) => ({ peer: p, acked })),
        adopted: tc.draw(gs.arrays(blob, { maxSize: 3 })).map((change) => ({
          change,
          ownBefore: peerCounters().map(([p, counter]) => ({
            peer: p,
            counter,
          })),
        })),
      });
      const record: LocalRecord = {
        channels: [channel("content"), channel("annotations")],
        decisions: {
          cursor: tc.draw(seq),
          confirmed: tc
            .draw(gs.arrays(gs.tuples(seq, blob), { maxSize: 4 }))
            .map(([s, r]) => ({ seq: s, record: r })),
          outbox: tc.draw(gs.arrays(blob, { maxSize: 4 })),
        },
        // ADR-0050 §4: absent in a record of before.
        ...(tc.draw(gs.booleans()) && {
          setAside: tc.draw(
            gs.arrays(
              gs.tuples(gs.text({ maxSize: 40 }), gs.text({ maxSize: 40 })),
              {
                maxSize: 4,
              },
            ),
          ),
        }),
      };
      expect(decodeRecord(encodeRecord(record))).toEqual(record);
    }));
});
