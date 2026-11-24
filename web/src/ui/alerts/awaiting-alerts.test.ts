// What to alert of (ADR-0060 §1; phase 34, NL1 to NL4): an annotation
// that awaits my reply and whose thread has a new entry since last seen;
// nothing for the state at opening, nothing while the view is watched.
import { describe, expect, test } from "vitest";
import { counter, resetCounters } from "../../perf/index.js";
import { AwaitingAlerts, type Thread } from "./awaiting-alerts.js";

/** A thread of `entries` entries: the annotation, then its replies. */
const thread = (id: string, entries: number): Thread => ({
  id,
  replies: Array.from({ length: entries - 1 }, () => ({})),
});

function observe(
  alerts: AwaitingAlerts,
  threads: Thread[],
  awaiting: string[],
  options: { opening?: boolean; settled?: boolean; watched?: boolean } = {},
) {
  return alerts.observe({
    annotations: threads,
    awaiting: new Set(awaiting),
    opening: options.opening ?? false,
    settled: options.settled ?? true,
    watched: options.watched ?? false,
  });
}

/** Opened on these threads, synchronized and verified. */
function opened(threads: Thread[], awaiting: string[]): AwaitingAlerts {
  const alerts = new AwaitingAlerts();
  observe(alerts, threads, awaiting, { opening: true, settled: false });
  expect(observe(alerts, threads, awaiting)).toEqual([]);
  return alerts;
}

describe("awaiting alerts", () => {
  test("nothing for what awaits me at opening (NL1)", () => {
    const alerts = new AwaitingAlerts();
    const threads = [thread("a", 1), thread("b", 2)];
    expect(observe(alerts, threads, ["a", "b"], { opening: true })).toEqual([]);
    expect(observe(alerts, threads, ["a", "b"])).toEqual([]);
  });

  test("the opening lasts until every signature is judged (NL1)", () => {
    const alerts = new AwaitingAlerts();
    // Synchronized, but a reply's verdict is still to come: it stays out.
    expect(observe(alerts, [thread("a", 2)], [], { settled: false })).toEqual(
      [],
    );
    // Judged: it comes in, as part of what the opening found.
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual([]);
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual([]);
  });

  test("a reply of another to my annotation alerts once (NL2, NL3)", () => {
    const alerts = opened([thread("a", 1)], []);
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual(["a"]);
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual([]);
  });

  test("a new annotation of another alerts", () => {
    const alerts = opened([], []);
    expect(observe(alerts, [thread("n", 1)], ["n"])).toEqual(["n"]);
  });

  test("a further reply to an annotation that awaits me alerts again", () => {
    const alerts = opened([thread("a", 2)], ["a"]);
    expect(observe(alerts, [thread("a", 3)], ["a"])).toEqual(["a"]);
  });

  test("nothing for an annotation that comes in without a new entry (NL3)", () => {
    // Set aside, then put back on another device; or my keys known late.
    const alerts = opened([thread("a", 2)], []);
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual([]);
  });

  test("nothing for my own reply, even if I am known late (NL3)", () => {
    const alerts = opened([thread("a", 2)], ["a"]);
    // My reply takes it out of the list, all verified: seen.
    expect(observe(alerts, [thread("a", 3)], [])).toEqual([]);
    // My keys change, and it reads as awaiting me again: no new entry.
    expect(observe(alerts, [thread("a", 3)], ["a"])).toEqual([]);
  });

  test("nothing seen while a signature is to judge (NL3)", () => {
    const alerts = opened([thread("a", 2)], ["a"]);
    // My reply from another device, its verdict to come: the index keeps
    // the annotation in the list meanwhile.
    expect(
      observe(alerts, [thread("a", 3)], ["a"], { settled: false }),
    ).toEqual([]);
    expect(observe(alerts, [thread("a", 3)], [])).toEqual([]);
  });

  test("a reply verified late alerts once verified (NL3)", () => {
    const alerts = opened([thread("a", 1)], []);
    // Arrived, its verdict to come: it neither comes in nor is seen.
    expect(observe(alerts, [thread("a", 2)], [], { settled: false })).toEqual(
      [],
    );
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual(["a"]);
  });

  test("several annotations at once, in their order", () => {
    const alerts = opened([thread("a", 1), thread("b", 1)], []);
    expect(
      observe(alerts, [thread("a", 2), thread("b", 3)], ["a", "b"]),
    ).toEqual(["a", "b"]);
  });

  test("nothing while watched, and nothing of it afterwards (NL4)", () => {
    const alerts = opened([thread("a", 1)], []);
    expect(observe(alerts, [thread("a", 2)], ["a"], { watched: true })).toEqual(
      [],
    );
    expect(observe(alerts, [thread("a", 2)], ["a"])).toEqual([]);
  });

  test("counts one observation, and each thread it reads", () => {
    const alerts = opened([thread("a", 1), thread("b", 1)], []);
    resetCounters();
    observe(alerts, [thread("a", 2), thread("b", 1)], ["a"]);
    expect(counter("alerts.observe")).toBe(1);
    expect(counter("alerts.thread")).toBe(2);
  });
});
