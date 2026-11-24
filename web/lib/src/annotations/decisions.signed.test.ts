// Signed decisions (docs/protocol/06-identity.md, ID-7, ID-9, ID-12, ID-16;
// analysis 18g): `sig` travels in the record and never changes whether it
// is valid — a malformed one is no signature, not an invalid record; the
// page's records leave in the order of its clicks, whatever order their
// signatures end in; once closed, none leaves.
import { describe, expect, test } from "vitest";
import {
  DecisionLog,
  LocalDecisions,
  type Proposal,
  decodeProposal,
  encodeProposal,
} from "./decisions.js";

const base = {
  proposalId: "p1",
  annotationId: "a1",
  decision: "reject" as const,
  author: "Alice",
};

describe("signed decisions", () => {
  test("ID-7: sig in base64, read back as bytes", () => {
    const sig = new Uint8Array(72).map((_, i) => i);
    const record = encodeProposal({ ...base, sig });
    expect(JSON.parse(new TextDecoder().decode(record)).sig).toBe(
      Buffer.from(sig).toString("base64"),
    );
    expect(decodeProposal(record)?.sig).toEqual(sig);
  });

  test("ID-16, D-25: a malformed sig leaves the record valid, without signature", () => {
    for (const sig of ["not base64!", "QQ=", 12, null, ["x"], { a: 1 }]) {
      const text = JSON.stringify({ ...base, sig });
      const read = decodeProposal(new TextEncoder().encode(text));
      expect(read, JSON.stringify(sig)).toEqual(base);
    }
  });

  test("records leave in the order of the clicks, signed; none once closed", async () => {
    const log = new DecisionLog();
    const published: Proposal[] = [];
    const ends: ((sig: Uint8Array) => void)[] = [];
    let n = 0;
    const decisions = new LocalDecisions(
      log,
      (record) => published.push(decodeProposal(record) as Proposal),
      () => `p${++n}`,
      Number.POSITIVE_INFINITY,
      () =>
        new Promise<Uint8Array>((resolve) => {
          ends.push(resolve);
        }),
    );
    expect(decisions.propose("a1", "accept", "Alice")).toBe(true);
    expect(decisions.propose("a2", "reject", "Alice")).toBe(true);
    // Pending from the click on.
    expect(decisions.outcome("a1")).toEqual({
      kind: "pending",
      decision: "accept",
    });
    expect(published).toEqual([]);
    // The second signature ends first: nothing leaves before the first.
    ends[1]?.(new Uint8Array(72).fill(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([]);
    ends[0]?.(new Uint8Array(72).fill(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published.map((p) => [p.proposalId, p.sig?.[0]])).toEqual([
      ["p1", 1],
      ["p2", 2],
    ]);
    // Closed while a signature runs: it never leaves.
    decisions.propose("a3", "reject", "Alice");
    decisions.close();
    ends[2]?.(new Uint8Array(72));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toHaveLength(2);
  });

  test("a signature that fails: the record leaves unsigned", async () => {
    const published: Proposal[] = [];
    const decisions = new LocalDecisions(
      new DecisionLog(),
      (record) => published.push(decodeProposal(record) as Proposal),
      () => "p1",
      Number.POSITIVE_INFINITY,
      async () => {
        throw new Error("no key");
      },
    );
    decisions.propose("a1", "reject", "Alice");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toEqual([{ ...base, decision: "reject" }]);
  });

  test("O-18: a record too large once signed isn't proposed", () => {
    const published: Uint8Array[] = [];
    const record = encodeProposal(base);
    const decisions = new LocalDecisions(
      new DecisionLog(),
      (r) => published.push(r),
      () => "p1",
      record.length + 10,
      async () => new Uint8Array(72),
    );
    expect(decisions.propose("a1", "reject", "Alice")).toBe(false);
    expect(decisions.outcome("a1")).toBeUndefined();
  });
});
