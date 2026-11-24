import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { RejoinCoalescer } from "./rejoin.js";

// The same actors as `Proposed2` (formal/decision-protocol), for one client:
// the server journals entries and signals connected clients; it processes
// joins in order and answers each with the entries after its `since`;
// signals and replies travel independently, so a signal may arrive before
// or after the reply to a join sent before it was emitted.
class World {
  log = 0; // entries journaled so far, seqs 1..log
  confirmedSeq = 0;
  connected = false;
  signals = 0;
  joins: number[] = []; // `since` of each join the server hasn't processed
  replies: number[] = []; // max seq of each computed, undelivered reply
  readonly coalescer = new RejoinCoalescer(() => {
    this.joins.push(this.confirmedSeq);
  });

  journal(): void {
    this.log++;
    if (this.connected) this.signals++;
  }
  deliverSignal(): void {
    if (this.signals === 0) return;
    this.signals--;
    this.coalescer.signal();
  }
  serverJoin(): void {
    const since = this.joins.shift();
    if (since === undefined) return;
    this.replies.push(Math.max(since, this.log));
  }
  deliverReply(): void {
    const upTo = this.replies.shift();
    if (upTo === undefined) return;
    this.confirmedSeq = Math.max(this.confirmedSeq, upTo);
    this.coalescer.replied();
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.signals = 0;
    this.joins = [];
    this.replies = [];
    this.coalescer.disconnected();
  }
  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.coalescer.connected();
  }
  quiet(): boolean {
    return (
      this.signals === 0 && this.joins.length === 0 && this.replies.length === 0
    );
  }
}

const ACTIONS = [
  "journal",
  "deliverSignal",
  "serverJoin",
  "deliverReply",
  "disconnect",
  "connect",
] as const;

type Action = (typeof ACTIONS)[number];

// Drains a world in a fixed order, journaling nothing new; returns whether
// everything journaled ended up confirmed.
function drainsToConfirmed(world: World): boolean {
  world.connect();
  for (let guard = 0; !world.quiet(); guard++) {
    if (guard > 1000) throw new Error("the rejoin loop never settles");
    if (world.signals > 0) world.deliverSignal();
    else if (world.joins.length > 0) world.serverJoin();
    else world.deliverReply();
  }
  return world.confirmedSeq === world.log;
}

function replay(actions: Action[]): World {
  const world = new World();
  for (const action of actions) world[action]();
  return world;
}

describe("RejoinCoalescer property tests", () => {
  // Checked after *every* step, like the model's invariant: checking only
  // at the end lets any later signal mask a lost one.
  test("from any reachable state, draining the network confirms every journaled entry", () =>
    hegel.test(
      (tc) => {
        const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));
        const actions: Action[] = [];
        for (let i = 0; i < steps; i++) {
          actions.push(tc.draw(gs.sampledFrom([...ACTIONS])));
          if (!drainsToConfirmed(replay(actions))) {
            throw new Error(`an entry is never confirmed after ${actions}`);
          }
        }
      },
      { testCases: 300 },
    ));
});
