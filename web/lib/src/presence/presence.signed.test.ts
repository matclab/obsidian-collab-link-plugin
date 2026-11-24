// Signed presence (docs/protocol/06-identity.md, ID-11; analysis 18g, case
// 10): a state carries `sig` and `pk`; states leave in the order of their
// counter, whatever order their signatures end in; a departure leaves at
// once, and what was still being signed never leaves; a receiver keeps a
// state whose `sig` or `pk` is malformed (D-32), without them.
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Presence } from "./presence.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const doc = () => {
  const d = new LoroDoc();
  d.getText("content").insert(0, "hello world");
  d.commit();
  return d;
};

const decode = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe("signed presence", () => {
  test("ID-11, case 10: sig and pk; states in the order of seq", async () => {
    const sent: Uint8Array[] = [];
    const ends: ((s: { sig: Uint8Array; pk: Uint8Array }) => void)[] = [];
    const seen: unknown[] = [];
    const a = new Presence({
      doc: doc(),
      name: () => "alice",
      publish: (bytes) => sent.push(bytes),
      seal: (fields) => {
        seen.push(fields);
        return new Promise((resolve) => ends.push(resolve));
      },
    });
    a.setSelection(1, 2);
    vi.advanceTimersByTime(0);
    a.setSelection(3, 4);
    vi.advanceTimersByTime(200);
    expect(ends).toHaveLength(2);
    expect(seen[0]).toMatchObject({ seq: 1, name: "alice" });
    // The second ends first: nothing before the first.
    ends[1]?.({
      sig: new Uint8Array(72).fill(2),
      pk: new Uint8Array(32).fill(9),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    ends[0]?.({
      sig: new Uint8Array(72).fill(1),
      pk: new Uint8Array(32).fill(9),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((b) => decode(b).seq)).toEqual([1, 2]);
    const first = decode(sent[0] as Uint8Array);
    expect(first.sig).toBe(
      Buffer.from(new Uint8Array(72).fill(1)).toString("base64"),
    );
    expect(first.pk).toBe(
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
    );
    // A third, then leaving: the departure at once, the third never.
    a.setSelection(5, 6);
    vi.advanceTimersByTime(200);
    a.leave();
    ends[2]?.({ sig: new Uint8Array(72), pk: new Uint8Array(32) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((b) => decode(b))).toEqual([
      expect.objectContaining({ seq: 1 }),
      expect.objectContaining({ seq: 2 }),
      { v: 1, key: first.key, seq: 4, gone: true },
    ]);
  });

  test("D-32: a malformed sig or pk is dropped, the state kept", () => {
    const b = new Presence({
      doc: doc(),
      name: () => "bob",
      publish: () => {},
    });
    const state = (extra: Record<string, unknown>, seq: number) =>
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          key: "ab".repeat(16),
          seq,
          name: "alice",
          color: "#d1495b",
          ...extra,
        }),
      );
    b.receive(state({ sig: "not base64!", pk: 3 }, 1));
    expect(b.others()).toEqual([
      expect.objectContaining({ name: "alice", seq: 1 }),
    ]);
    expect(b.others()[0]?.sig).toBeUndefined();
    const sig = Buffer.from(new Uint8Array(72).fill(7)).toString("base64");
    const pk = Buffer.from(new Uint8Array(32).fill(8)).toString("base64");
    b.receive(state({ sig, pk }, 2));
    expect(b.others()[0]).toMatchObject({
      seq: 2,
      sig: new Uint8Array(72).fill(7),
      pk: new Uint8Array(32).fill(8),
    });
  });
});
