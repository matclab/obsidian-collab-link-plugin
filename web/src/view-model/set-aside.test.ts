import { describe, expect, test } from "vitest";
import { SetAside } from "./set-aside.js";

// What I set aside (ADR-0050 §4): an annotation, at its last entry then;
// put back; restored from the record; pruned of what is closed or gone
// when the record is captured.
describe("SetAside", () => {
  test("set aside at an entry, put back; each change moves the version and tells", () => {
    const aside = new SetAside();
    let told = 0;
    aside.subscribe(() => told++);
    aside.set("a1", "r2");
    expect(aside.get("a1")).toBe("r2");
    expect(aside.version).toBe(1);
    aside.clear("a1");
    expect(aside.get("a1")).toBeUndefined();
    expect([aside.version, told]).toEqual([2, 2]);
    // Nothing to change: nothing told.
    aside.clear("a1");
    aside.set("a2", "a2");
    aside.set("a2", "a2");
    expect([aside.version, told]).toEqual([3, 3]);
  });

  test("restored from the record, and given back pruned", () => {
    const aside = new SetAside([
      ["a1", "r1"],
      ["a2", "a2"],
    ]);
    expect(aside.get("a2")).toBe("a2");
    expect(aside.stored((id) => id !== "a1")).toEqual([["a2", "a2"]]);
    // Pruned in the record only: still set aside here.
    expect(aside.get("a1")).toBe("r1");
  });
});
