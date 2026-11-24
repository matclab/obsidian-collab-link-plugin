import { expect, test } from "vitest";
import { fileDate } from "./file-date.js";

test("a copy's date: local, day and minute, nothing a file system refuses (decision 21)", () => {
  expect(fileDate(new Date(2026, 9, 14, 15, 2, 59))).toBe("2026-10-14 15h02");
  expect(fileDate(new Date(2027, 0, 5, 9, 7))).toBe("2027-01-05 09h07");
  expect(fileDate(new Date(2026, 9, 14, 0, 0))).not.toMatch(/[:/\\]/);
});
