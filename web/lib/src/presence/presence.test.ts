// The page's presence (ADR-0025, format of ADR-0026), without the
// network: its own state published at most every 200 ms when it changes,
// again every 10 s; the others' states applied by their pages' counters,
// resolved to positions in the text, forgotten 30 s after the last one
// received — by the receiver's clock, whatever the sender's; a clean leave
// published at once.
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostileCursorBytes } from "../test-support/hostile-cursor.js";
import { Presence } from "./presence.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Two pages on one text, their presences wired to each other by hand. */
function pair(text = "hello world") {
  const docA = new LoroDoc();
  docA.getText("content").insert(0, text);
  docA.commit();
  const docB = new LoroDoc();
  docB.import(docA.export({ mode: "snapshot" }));
  const sentByA: Uint8Array[] = [];
  const sentByB: Uint8Array[] = [];
  let nameA = "alice";
  const a = new Presence({
    doc: docA,
    name: () => nameA,
    publish: (bytes) => sentByA.push(bytes),
  });
  const b = new Presence({
    doc: docB,
    name: () => "bob",
    publish: (bytes) => sentByB.push(bytes),
  });
  const deliverToB = () => {
    for (const bytes of sentByA.splice(0)) b.receive(bytes);
  };
  return {
    docA,
    docB,
    a,
    b,
    sentByA,
    sentByB,
    deliverToB,
    rename: (name: string) => {
      nameA = name;
    },
  };
}

describe("Presence", () => {
  test("a selection is published, and the other sees it where it is", () => {
    const { a, b, sentByA, deliverToB } = pair();

    a.setSelection(6, 11);
    vi.advanceTimersByTime(0);

    expect(sentByA).toHaveLength(1);
    deliverToB();
    const [alice] = b.others();
    expect(alice).toMatchObject({ name: "alice", anchor: 6, head: 11 });
    expect(alice?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(a.others()).toEqual([]);
  });

  test("phase 7, P5: moving fast publishes at most once per 200 ms, the latest", () => {
    const { a, b, sentByA, deliverToB } = pair();

    for (let at = 0; at <= 10; at++) {
      a.setSelection(at, at);
      vi.advanceTimersByTime(20);
    }
    // 11 moves in 220 ms: the first at once, then one per interval.
    expect(sentByA.length).toBeLessThanOrEqual(3);
    vi.advanceTimersByTime(200);
    deliverToB();
    expect(b.others()[0]).toMatchObject({ anchor: 10, head: 10 });
  });

  test("republished every 10 s; forgotten 30 s after the last one received", async () => {
    const { a, b, sentByA, deliverToB } = pair();
    a.setSelection(0, 0);
    vi.advanceTimersByTime(0);
    deliverToB();

    vi.advanceTimersByTime(10_000);
    expect(sentByA).toHaveLength(1); // the heartbeat
    sentByA.length = 0; // lost: b hears nothing more
    const changes: number[] = [];
    b.subscribe(() => changes.push(b.others().length));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(b.others()).toEqual([]);
    expect(changes).toContain(0);
  });

  test("R-P5: leaving is published at once, and the other forgets it", () => {
    const { a, b, sentByA, deliverToB } = pair();
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    deliverToB();
    expect(b.others()).toHaveLength(1);

    a.leave();

    expect(sentByA).toHaveLength(1);
    deliverToB();
    expect(b.others()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(sentByA).toHaveLength(0); // nothing more after leaving
  });

  test("R-P6: connected, it publishes its state again at once", () => {
    const { a, sentByA } = pair();
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    sentByA.length = 0;

    a.connected();
    vi.advanceTimersByTime(0);

    expect(sentByA).toHaveLength(1);
  });

  test("renamed, the next publication carries the new name", () => {
    const { a, b, deliverToB, rename } = pair();
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    rename("Alice B.");

    a.renamed();
    vi.advanceTimersByTime(200);
    deliverToB();

    expect(b.others()[0]?.name).toBe("Alice B.");
  });

  test("R-P4: a cursor on text not received yet is kept, unresolved, until it comes", () => {
    const { docA, docB, a, b, deliverToB } = pair("");
    const before = docA.oplogVersion();
    docA.getText("content").insert(0, "typed by alice");
    docA.commit();
    // Inside the text: a cursor at its very end has no character to hold
    // and resolves to the end anywhere (Loro).
    a.setSelection(6, 8);
    vi.advanceTimersByTime(0);
    deliverToB();

    expect(b.others()[0]).toMatchObject({
      name: "alice",
      anchor: undefined,
      head: undefined,
    });
    docB.import(docA.export({ mode: "update", from: before }));
    expect(b.others()[0]).toMatchObject({ anchor: 6, head: 8 });
  });

  test("an unreadable state is dropped, not thrown", () => {
    const { b } = pair();
    expect(() => b.receive(new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(b.others()).toEqual([]);
  });

  test("an older state arriving late doesn't replace a newer one", () => {
    const { a, b, sentByA } = pair();
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    a.setSelection(5, 5);
    vi.advanceTimersByTime(200);
    const [older, newer] = sentByA;
    if (!older || !newer) throw new Error("two publications expected");

    b.receive(newer);
    b.receive(older);

    expect(b.others()[0]).toMatchObject({ anchor: 5 });
  });

  // ADR-0026: what Loro's EphemeralStore got wrong.
  test("a page whose clock is two minutes behind is shown, for 30 s after reception", () => {
    const { a, b, sentByA, deliverToB } = pair();
    const now = Date.now();
    vi.setSystemTime(now - 120_000);
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    vi.setSystemTime(now);
    expect(sentByA).toHaveLength(1);

    deliverToB();
    expect(b.others()).toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(b.others()).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(b.others()).toEqual([]);
  });

  test("leaving within the same millisecond as the last publication still leaves", () => {
    const { a, b, sentByA, deliverToB } = pair();
    a.setSelection(1, 1);
    vi.advanceTimersByTime(0);
    a.leave();
    expect(sentByA).toHaveLength(2);

    deliverToB();

    expect(b.others()).toEqual([]);
  });

  test("a cursor that would trap is shown unresolved, and the text stays usable (D-37)", () => {
    const { b, docB } = pair();
    const hostile = btoa(String.fromCharCode(...hostileCursorBytes()));
    const key = "0123456789abcdef0123456789abcdef";
    b.receive(
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          key,
          seq: 1,
          name: "x",
          color: "#000000",
          anchor: hostile,
          head: hostile,
        }),
      ),
    );

    const [other] = b.others();
    expect(other?.anchor).toBeUndefined();
    expect(other?.head).toBeUndefined();
    docB.export({ mode: "snapshot" });
    docB.getText("content").insert(0, "x");
    docB.commit();
  });

  test("a malformed state is ignored", () => {
    const { b } = pair();
    const json = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value));
    const key = "0123456789abcdef0123456789abcdef";
    for (const state of [
      { v: 2, key, seq: 1, name: "x", color: "#000000" },
      { v: 1, key: "short", seq: 1, name: "x", color: "#000000" },
      { v: 1, key, seq: -1, name: "x", color: "#000000" },
      { v: 1, key, seq: 1.5, name: "x", color: "#000000" },
      { v: 1, key, seq: 1, name: "x".repeat(201), color: "#000000" },
      { v: 1, key, seq: 1, name: "x", color: "red" },
      { v: 1, key, seq: 1, name: 5, color: "#000000" },
      { v: 1, key, seq: 1, name: "x", color: "#000000", anchor: "%%" },
    ]) {
      b.receive(json(state));
    }
    expect(b.others()).toEqual([]);
    b.receive(json({ v: 1, key, seq: 1, name: "x", color: "#000000" }));
    expect(b.others()).toHaveLength(1);
  });
});

// Phase 9, R3: a Loro panic while resolving another page's cursor reaches
// whoever halts the page, instead of leaving the cursor silently unshown.
describe("a Loro panic while resolving a cursor", () => {
  test("is handed to onTrap", () => {
    const { docA, a, sentByA } = pair();
    a.setSelection(1, 2);
    vi.advanceTimersByTime(1000);
    const traps: unknown[] = [];
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const b = new Presence({
      doc: docB,
      name: () => "bob",
      publish: () => {},
      onTrap: (error) => traps.push(error),
    });
    for (const bytes of sentByA) b.receive(bytes);
    const trap = new WebAssembly.RuntimeError("unreachable");
    vi.spyOn(docB, "getCursorPos").mockImplementation(() => {
      throw trap;
    });
    b.others();
    // Its anchor and its head: each resolution is told.
    expect(traps.length).toBeGreaterThan(0);
    expect(traps.every((error) => error === trap)).toBe(true);
    b.destroy();
  });
});
