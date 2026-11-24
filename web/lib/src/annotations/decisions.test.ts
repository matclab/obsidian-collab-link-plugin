import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  DecisionLog,
  LocalDecisions,
  type Proposal,
  decodeProposal,
  encodeProposal,
} from "./decisions.js";

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  proposalId: "p-1",
  annotationId: "a-1",
  decision: "accept",
  author: "Alice",
  ...overrides,
});

const record = (seq: number, p: Proposal) => ({
  seq,
  record: encodeProposal(p),
});

describe("proposal records", () => {
  test("round-trip", () => {
    expect(decodeProposal(encodeProposal(proposal()))).toEqual(proposal());
  });

  test("a malformed record decodes to undefined rather than throwing", () => {
    expect(decodeProposal(new Uint8Array([0xff, 0x00]))).toBeUndefined();
    expect(
      decodeProposal(new TextEncoder().encode('{"decision":"maybe"}')),
    ).toBeUndefined();
    expect(
      decodeProposal(
        new TextEncoder().encode(
          JSON.stringify({ ...proposal(), decision: "maybe" }),
        ),
      ),
    ).toBeUndefined();
  });

  test("a resolution round-trips (ADR-0018: resolving goes through decisions)", () => {
    const resolve = proposal({ decision: "resolve" });
    expect(decodeProposal(encodeProposal(resolve))).toEqual(resolve);
  });

  test("an acceptance carrying a change round-trips it", () => {
    const accept = proposal({ change: new Uint8Array([0, 1, 254, 255]) });
    expect(decodeProposal(encodeProposal(accept))).toEqual(accept);
  });

  test("a change on anything but an acceptance, or not base64, is malformed", () => {
    const encode = (value: object) =>
      new TextEncoder().encode(JSON.stringify({ ...proposal(), ...value }));
    expect(
      decodeProposal(encode({ decision: "reject", change: "AAE=" })),
    ).toBeUndefined();
    expect(
      decodeProposal(encode({ decision: "resolve", change: "AAE=" })),
    ).toBeUndefined();
    expect(decodeProposal(encode({ change: "not base64!" }))).toBeUndefined();
    expect(decodeProposal(encode({ change: 12 }))).toBeUndefined();
  });
});

/** A detached change of `peer`, inserting `text` (its op ids: counters
 * `[0, text.length)`). */
function changeOf(peer: bigint, text: string): Uint8Array {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  doc.getText("content").insert(0, text);
  doc.commit();
  return doc.export({ mode: "update" });
}

describe("DecisionLog, by class of decision (ADR-0018)", () => {
  test("a suggestion's decision and a comment's resolution are separate winners", () => {
    const log = new DecisionLog();
    log.add([
      record(1, proposal({ proposalId: "r", decision: "resolve" })),
      record(2, proposal({ proposalId: "a", decision: "accept" })),
      record(3, proposal({ proposalId: "r2", decision: "resolve" })),
    ]);
    expect(log.winner("a-1")?.proposalId).toBe("a");
    expect(log.resolution("a-1")?.proposalId).toBe("r");
  });

  test("an acceptance whose change's ids an earlier acceptance took is void", () => {
    const log = new DecisionLog();
    log.add([
      record(1, proposal({ annotationId: "x", change: changeOf(42n, "big") })),
      record(2, proposal({ annotationId: "y", change: changeOf(42n, "red") })),
      record(3, proposal({ annotationId: "z", change: changeOf(43n, "fat") })),
    ]);
    expect(log.winner("x")?.void).toBeUndefined();
    expect(log.winner("y")?.void).toBe(true);
    expect(log.winner("z")?.void).toBeUndefined();
  });

  test("only winning acceptances take ids: a losing one takes nothing", () => {
    const log = new DecisionLog();
    log.add([
      record(1, proposal({ annotationId: "x", decision: "reject" })),
      record(
        2,
        proposal({
          proposalId: "late",
          annotationId: "x",
          change: changeOf(42n, "big"),
        }),
      ),
      record(3, proposal({ annotationId: "y", change: changeOf(42n, "red") })),
    ]);
    expect(log.winner("y")?.void).toBeUndefined();
  });

  test("a void acceptance takes nothing either", () => {
    const log = new DecisionLog();
    log.add([
      record(1, proposal({ annotationId: "x", change: changeOf(42n, "ab") })),
      record(2, proposal({ annotationId: "y", change: changeOf(42n, "abcd") })),
      record(3, proposal({ annotationId: "z", change: changeOf(99n, "q") })),
    ]);
    expect(log.winner("y")?.void).toBe(true);
    expect(log.winner("z")?.void).toBeUndefined();
  });

  test("an acceptance whose change is not a Loro update is void", () => {
    const log = new DecisionLog();
    log.add([record(1, proposal({ change: new Uint8Array([1, 2, 3]) }))]);
    expect(log.winner("a-1")?.void).toBe(true);
  });
});

describe("DecisionLog", () => {
  test("no winner before any confirmed proposal", () => {
    expect(new DecisionLog().winner("a-1")).toBeUndefined();
  });

  test("the first confirmed proposal for an annotation wins, later ones lose", () => {
    const log = new DecisionLog();
    log.add([
      record(3, proposal({ proposalId: "p-a", decision: "reject" })),
      record(5, proposal({ proposalId: "p-b", decision: "accept" })),
    ]);
    log.add([record(8, proposal({ proposalId: "p-c" }))]);

    expect(log.winner("a-1")).toMatchObject({
      proposalId: "p-a",
      decision: "reject",
      seq: 3,
    });
  });

  test("annotations are decided independently", () => {
    const log = new DecisionLog();
    log.add([
      record(1, proposal({ annotationId: "a-1", decision: "accept" })),
      record(2, proposal({ annotationId: "a-2", decision: "reject" })),
    ]);
    expect(log.winner("a-1")?.decision).toBe("accept");
    expect(log.winner("a-2")?.decision).toBe("reject");
  });

  test("a malformed record is skipped without hiding later valid ones", () => {
    const log = new DecisionLog();
    log.add([
      { seq: 1, record: new Uint8Array([1, 2, 3]) },
      record(2, proposal()),
    ]);
    expect(log.winner("a-1")?.seq).toBe(2);
  });

  test("tells whether a given proposal has been confirmed", () => {
    const log = new DecisionLog();
    log.add([record(1, proposal({ proposalId: "mine" }))]);
    expect(log.isConfirmed("mine")).toBe(true);
    expect(log.isConfirmed("other")).toBe(false);
  });

  test("notifies listeners after each batch", () => {
    const log = new DecisionLog();
    let calls = 0;
    log.subscribe(() => calls++);
    log.add([record(1, proposal())]);
    log.add([]);
    expect(calls).toBe(1);
  });
});

describe("LocalDecisions", () => {
  function setUp() {
    const log = new DecisionLog();
    const published: Uint8Array[] = [];
    let n = 0;
    const local = new LocalDecisions(
      log,
      (record) => published.push(record),
      () => `mine-${++n}`,
    );
    return { log, published, local };
  }

  test("proposing publishes the encoded proposal and is pending until confirmed", () => {
    const { published, local } = setUp();

    local.propose("a-1", "accept", "Alice");

    expect(published.map(decodeProposal)).toEqual([
      {
        proposalId: "mine-1",
        annotationId: "a-1",
        decision: "accept",
        author: "Alice",
      },
    ]);
    expect(local.outcome("a-1")).toEqual({
      kind: "pending",
      decision: "accept",
    });
  });

  // docs/protocol/04-obligations.md, O-18: a record beyond the server's
  // message limit would be cut, then sent again at every reconnection.
  test("a proposal too large for a frame is refused, and nothing is published", () => {
    const log = new DecisionLog();
    const published: Uint8Array[] = [];
    const local = new LocalDecisions(
      log,
      (record) => published.push(record),
      () => "mine",
      1000,
    );
    const change = new Uint8Array(800); // 1068 bytes in base64

    expect(local.propose("a-1", "accept", "Alice", change)).toBe(false);
    expect(published).toEqual([]);
    expect(local.outcome("a-1")).toBeUndefined();
    expect(local.propose("a-1", "reject", "Alice")).toBe(true);
    expect(published).toHaveLength(1);
  });

  test("our proposal confirmed first: won", () => {
    const { log, published, local } = setUp();
    local.propose("a-1", "accept", "Alice");
    log.add([{ seq: 4, record: published[0] as Uint8Array }]);

    expect(local.outcome("a-1")).toEqual({ kind: "won" });
  });

  test("someone else's proposal confirmed first: lost, with the winner", () => {
    const { log, published, local } = setUp();
    local.propose("a-1", "accept", "Alice");
    log.add([
      record(
        3,
        proposal({ proposalId: "theirs", decision: "reject", author: "Bob" }),
      ),
      { seq: 4, record: published[0] as Uint8Array },
    ]);

    expect(local.outcome("a-1")).toMatchObject({
      kind: "lost",
      winner: { author: "Bob", decision: "reject" },
    });
  });

  test("an acceptance can carry a change, published with it", () => {
    const { published, local } = setUp();
    const change = new Uint8Array([7, 8, 9]);
    local.propose("a-1", "accept", "Alice", change);
    expect(decodeProposal(published[0] as Uint8Array)?.change).toEqual(change);
  });

  test("a resolution's outcome follows the resolutions, not the suggestion's decision", () => {
    const { log, published, local } = setUp();
    local.propose("a-1", "resolve", "Alice");
    log.add([
      record(1, proposal({ proposalId: "other", decision: "accept" })),
      { seq: 2, record: published[0] as Uint8Array },
    ]);
    expect(local.outcome("a-1")).toEqual({ kind: "won" });
  });

  test("no outcome for an annotation we never decided", () => {
    expect(setUp().local.outcome("a-1")).toBeUndefined();
  });
});
