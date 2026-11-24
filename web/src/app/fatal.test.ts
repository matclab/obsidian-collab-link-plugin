// @vitest-environment jsdom
//
// A Loro panic may surface anywhere — the editor binding, the annotation
// index, a preview — not only at import: the page watches its window for
// one, and ignores every other error (docs/phase-9-durcissement.md,
// analysis L4).
import { describe, expect, test } from "vitest";
import { watchForTraps } from "./fatal.js";

function rejection(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

describe("watchForTraps", () => {
  test("hands over a panic, thrown or rejected", () => {
    const seen: unknown[] = [];
    const target = new EventTarget();
    watchForTraps(target, (error) => seen.push(error));
    const thrown = new WebAssembly.RuntimeError("unreachable");
    const rejected = new WebAssembly.RuntimeError("unreachable");

    target.dispatchEvent(new ErrorEvent("error", { error: thrown }));
    target.dispatchEvent(rejection(rejected));

    expect(seen).toEqual([thrown, rejected]);
  });

  test("ignores every other error", () => {
    const seen: unknown[] = [];
    const target = new EventTarget();
    watchForTraps(target, (error) => seen.push(error));

    target.dispatchEvent(new ErrorEvent("error", { error: new Error("boom") }));
    target.dispatchEvent(new ErrorEvent("error", { message: "script error" }));
    target.dispatchEvent(rejection(new TypeError("x")));
    target.dispatchEvent(rejection(undefined));

    expect(seen).toEqual([]);
  });

  test("stops watching when told", () => {
    const seen: unknown[] = [];
    const target = new EventTarget();
    const stop = watchForTraps(target, (error) => seen.push(error));
    stop();

    target.dispatchEvent(
      new ErrorEvent("error", { error: new WebAssembly.RuntimeError("x") }),
    );

    expect(seen).toEqual([]);
  });
});
