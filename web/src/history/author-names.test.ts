import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { registerPeers } from "../../lib/src/history/tables.js";
import { AuthorNames } from "./author-names.js";

function setUp() {
  const annotationsDoc = new LoroDoc();
  const queue: (() => void)[] = [];
  const names = new AuthorNames(annotationsDoc, (run) => queue.push(run));
  let told = 0;
  names.subscribe(() => told++);
  const flush = () => {
    for (const run of queue.splice(0)) run();
  };
  return { annotationsDoc, names, queue, flush, told: () => told };
}

describe("AuthorNames", () => {
  test("the names, read again once the peers table changed", () => {
    const { annotationsDoc, names, flush, told } = setUp();
    expect(names.current().size).toBe(0);
    registerPeers(annotationsDoc, ["1"], "alice");
    flush();
    expect(told()).toBe(1);
    expect(names.current().get("1")).toBe("alice");
  });

  test("told once per flush, whatever the number of changes", () => {
    const { annotationsDoc, flush, queue, told } = setUp();
    registerPeers(annotationsDoc, ["1"], "alice");
    registerPeers(annotationsDoc, ["2"], "bob");
    expect(queue).toHaveLength(1);
    flush();
    expect(told()).toBe(1);
  });

  test("a change elsewhere in the doc tells nothing", () => {
    const { annotationsDoc, flush, queue, told } = setUp();
    annotationsDoc.getMap("versions").set("x", 1);
    annotationsDoc.commit();
    flush();
    expect(queue).toHaveLength(0);
    expect(told()).toBe(0);
  });

  test("the same map while nothing changed", () => {
    const { names } = setUp();
    expect(names.current()).toBe(names.current());
  });

  test("destroyed, it tells nothing more", () => {
    const { annotationsDoc, names, flush, told } = setUp();
    names.destroy();
    registerPeers(annotationsDoc, ["1"], "alice");
    flush();
    expect(told()).toBe(0);
  });
});

// Found in Chromium (phase 33d): `queueMicrotask` called as a method of
// the index threw « Illegal invocation », which Node lets pass.
test("its default schedule calls queueMicrotask alone", async () => {
  const native = queueMicrotask;
  const strict = vi.fn(function (this: unknown, run: () => void) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    native(run);
  });
  vi.stubGlobal("queueMicrotask", strict);
  try {
    const annotationsDoc = new LoroDoc();
    const names = new AuthorNames(annotationsDoc);
    let told = 0;
    names.subscribe(() => told++);
    registerPeers(annotationsDoc, ["1"], "alice");
    await Promise.resolve();
    expect(strict).toHaveBeenCalled();
    expect(told).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
