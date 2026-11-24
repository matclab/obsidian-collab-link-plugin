import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { AckQueue, JoinQueue } from "./pairing.js";
import type { ChannelName } from "./protocol.js";

const CHANNELS: ChannelName[] = ["content", "annotations", "decisions"];

describe("AckQueue property tests", () => {
  // The model: the channels of the frames sent and not acked yet, in the
  // order they were sent (W-47: the server acks in the order it received).
  test("an ack settles the oldest frame in flight, of its channel only; a drop settles all", () =>
    hegel.test(
      (tc) => {
        const queue = new AckQueue();
        const inFlight: { channel: ChannelName; id: number }[] = [];
        const settled = new Map<number, number | undefined>();
        let next = 0;
        const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
        for (let i = 0; i < steps; i++) {
          const act = tc.draw(gs.sampledFrom(["send", "ack", "drop"]));
          const channel = tc.draw(gs.sampledFrom(CHANNELS));
          if (act === "send") {
            const id = next++;
            inFlight.push({ channel, id });
            queue.push(channel, (seq) => {
              expect(settled.has(id)).toBe(false);
              settled.set(id, seq);
            });
          } else if (act === "ack") {
            const seq = tc.draw(gs.integers({ minValue: 1, maxValue: 99 }));
            const head = inFlight[0];
            const paired = head?.channel === channel;
            expect(queue.resolveNext(channel, seq)).toBe(paired);
            if (paired && head) {
              inFlight.shift();
              expect(settled.get(head.id)).toBe(seq);
            }
          } else {
            queue.failAll();
            for (const { id } of inFlight.splice(0)) {
              expect(settled.has(id)).toBe(true);
              expect(settled.get(id)).toBeUndefined();
            }
          }
          // Nothing still in flight is settled, everything else is.
          for (const { id } of inFlight) expect(settled.has(id)).toBe(false);
          expect(settled.size).toBe(next - inFlight.length);
        }
      },
      { testCases: 300 },
    ));
});

describe("JoinQueue", () => {
  test("replies pair with joins in the order they were sent, and a reset forgets the old ones", () => {
    const queue = new JoinQueue();
    const replied: string[] = [];
    const join = (channel: ChannelName) => ({
      channel,
      onReplied: () => replied.push(channel),
    });
    queue.push(join("content"));
    queue.reset([join("annotations"), join("decisions")]);
    queue.push(join("content"));

    for (let reply = queue.shift(); reply; reply = queue.shift()) {
      reply.onReplied(undefined);
    }

    expect(replied).toEqual(["annotations", "decisions", "content"]);
    expect(queue.shift()).toBeUndefined();
  });
});
