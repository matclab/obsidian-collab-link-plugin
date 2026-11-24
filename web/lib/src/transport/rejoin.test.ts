import { describe, expect, test } from "vitest";
import { RejoinCoalescer } from "./rejoin.js";

function coalescer() {
  let joins = 0;
  const c = new RejoinCoalescer(() => {
    joins++;
  });
  return { c, joins: () => joins };
}

describe("RejoinCoalescer", () => {
  test("connecting sends the initial join", () => {
    const { c, joins } = coalescer();
    c.connected();
    expect(joins()).toBe(1);
  });

  test("a signal while idle sends a join", () => {
    const { c, joins } = coalescer();
    c.connected();
    c.replied();
    c.signal();
    expect(joins()).toBe(2);
  });

  test("signals while a join is in flight are coalesced into one more join after the reply", () => {
    const { c, joins } = coalescer();
    c.connected();
    c.signal();
    c.signal();
    expect(joins()).toBe(1);
    c.replied();
    expect(joins()).toBe(2);
    c.replied();
    expect(joins()).toBe(2);
  });

  // The race the Event-B model finds when a busy signal is dropped
  // (formal/decision-protocol, Proposed2): the server computed the reply
  // before journaling our own proposal, and the ack arrives while the reply
  // is still being imported. Only a second join can confirm it.
  test("an ack arriving while the reply is imported is not lost", () => {
    const { c, joins } = coalescer();
    c.connected();
    c.signal(); // own ack, reply already computed without it
    c.replied();
    expect(joins()).toBe(2);
  });

  test("a signal while disconnected sends nothing; reconnecting joins", () => {
    const { c, joins } = coalescer();
    c.connected();
    c.disconnected();
    c.signal();
    expect(joins()).toBe(1);
    c.connected();
    expect(joins()).toBe(2);
  });

  test("a dirty flag does not survive a disconnection (the reconnect join covers it)", () => {
    const { c, joins } = coalescer();
    c.connected();
    c.signal();
    c.disconnected();
    c.connected();
    c.replied();
    expect(joins()).toBe(2);
  });
});
