import type { LocalRecord } from "../record.js";

const bytes = (...values: number[]) => new Uint8Array(values);

/** A record with every field filled. */
export const sample: LocalRecord = {
  channels: [
    {
      channel: "content",
      snapshot: bytes(1, 2, 3),
      cursor: 7,
      own: [{ peer: "12", acked: 4 }],
      adopted: [
        { change: bytes(9, 9), ownBefore: [{ peer: "12", counter: 3 }] },
      ],
    },
    {
      channel: "annotations",
      snapshot: bytes(),
      cursor: 0,
      own: [],
      adopted: [],
    },
  ],
  decisions: {
    cursor: 5,
    confirmed: [{ seq: 5, record: bytes(42) }],
    outbox: [bytes(1), bytes(2)],
  },
};
