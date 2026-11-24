import { expect, test } from "vitest";
import { syncState } from "./sync-state.js";

test("what the header says of this browser's changes (analysis 10b.1)", () => {
  expect(syncState(0, true)).toBe("saved");
  expect(syncState(0, false)).toBe("saved");
  expect(syncState(3, true)).toBe("sending");
  expect(syncState(3, false)).toBe("offline");
});
