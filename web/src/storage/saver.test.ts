import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LocalRecord } from "./record.js";
import { Saver } from "./saver.js";
import { sample } from "./test-support/sample.js";

/** A save the test finishes when it wants. */
function controlledSaves() {
  const started: { record: LocalRecord; finish: (error?: Error) => void }[] =
    [];
  const save = (record: LocalRecord) =>
    new Promise<void>((resolve, reject) => {
      started.push({
        record,
        finish: (error) => (error ? reject(error) : resolve()),
      });
    });
  return { started, save };
}

/** A capture whose record says how many times it was taken. */
function counter() {
  let captures = 0;
  return () => {
    captures++;
    return { ...sample, decisions: { ...sample.decisions, cursor: captures } };
  };
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

describe("Saver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("changes within the delay give one save, at most the delay after the first", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    saver.changed();
    await vi.advanceTimersByTimeAsync(400);
    saver.changed();
    saver.changed();
    await vi.advanceTimersByTimeAsync(599);
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(1);
  });

  test("steady typing still saves every delay, not only once it stops", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    for (let i = 0; i < 10; i++) {
      saver.changed();
      await vi.advanceTimersByTimeAsync(300);
      for (const pending of started) pending.finish();
    }
    expect(started.length).toBeGreaterThanOrEqual(2);
  });

  test("one save at a time, written in capture order (R-L2)", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    saver.changed();
    saver.flush();
    expect(started).toHaveLength(1);
    saver.changed();
    saver.flush(); // while the first is in progress
    await flushMicrotasks();
    expect(started).toHaveLength(1);

    started[0]?.finish();
    await flushMicrotasks();
    expect(started).toHaveLength(2);
    // Captured when it started, after the first finished: the latest state.
    expect(started[1]?.record.decisions.cursor).toBe(2);
  });

  test("a change during a save is saved after it", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    saver.changed();
    await vi.advanceTimersByTimeAsync(1000);
    saver.changed();
    started[0]?.finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(2);
  });

  test("flush saves at once, and only if something changed", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    saver.flush();
    expect(started).toHaveLength(0);
    saver.changed();
    saver.flush();
    expect(started).toHaveLength(1);
    started[0]?.finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toHaveLength(1); // the timer went with the flush
  });

  test("a failed save is reported, and the next change saves again", async () => {
    const { started, save } = controlledSaves();
    const onError = vi.fn();
    const saver = new Saver({
      capture: counter(),
      save,
      delayMs: 1000,
      onError,
    });

    saver.changed();
    saver.flush();
    started[0]?.finish(new Error("QuotaExceededError"));
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledOnce();

    // Not saved: a flush (the page closing) tries again, with no change.
    saver.flush();
    expect(started).toHaveLength(2);
    // but a failure doesn't retry by itself, every delay.
    started[1]?.finish(new Error("QuotaExceededError"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toHaveLength(2);
  });

  test("after close, nothing more is saved", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });

    saver.changed();
    saver.close();
    await vi.advanceTimersByTimeAsync(5000);
    saver.flush();
    expect(started).toHaveLength(0);
  });

  // Closing a view in the plugin (phase 14, decision 17): the lock is
  // released after the last save, so nothing typed is lost at closing.
  test("drain saves what changed at once, resolves once it is saved, and nothing is saved after", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });
    let drained = false;

    saver.changed();
    const draining = saver.drain().then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(started).toHaveLength(1);
    expect(drained).toBe(false);
    started[0]?.finish();
    await draining;

    saver.changed();
    saver.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toHaveLength(1);
  });

  test("drain during a save waits for it, then saves what changed meanwhile", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save, delayMs: 1000 });
    let drained = false;

    saver.changed();
    saver.flush();
    saver.changed(); // during the save
    const draining = saver.drain().then(() => {
      drained = true;
    });
    // One save at a time (R-L2): the next waits for this one.
    await flushMicrotasks();
    expect(started).toHaveLength(1);
    started[0]?.finish();
    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(started[1]?.record.decisions.cursor).toBe(2);
    expect(drained).toBe(false);
    started[1]?.finish();
    await draining;
    expect(started).toHaveLength(2);
  });

  test("drain resolves even if its save fails, reported, and tries no more", async () => {
    const { started, save } = controlledSaves();
    const onError = vi.fn();
    const saver = new Saver({ capture: counter(), save, onError });

    saver.changed();
    const draining = saver.drain();
    await flushMicrotasks();
    started[0]?.finish(new Error("QuotaExceededError"));
    await draining;

    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toHaveLength(1);
  });

  test("drain with nothing changed saves nothing", async () => {
    const { started, save } = controlledSaves();
    const saver = new Saver({ capture: counter(), save });
    await saver.drain();
    expect(started).toHaveLength(0);
  });
});
