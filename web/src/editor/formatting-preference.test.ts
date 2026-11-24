// @vitest-environment jsdom
// The editor shows the text formatted or its source (phase 11, decision
// 4): formatted unless this browser chose the source.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FORMATTING_KEY,
  storeFormatting,
  storedFormatting,
} from "./formatting-preference.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("formatting preference", () => {
  test("formatted by default", () => {
    expect(storedFormatting(localStorage)).toBe(true);
  });

  test("the source, once chosen in this browser, until formatted again", () => {
    storeFormatting(false, localStorage);
    expect(localStorage.getItem(FORMATTING_KEY)).toBe("source");
    expect(storedFormatting(localStorage)).toBe(false);
    storeFormatting(true, localStorage);
    expect(localStorage.getItem(FORMATTING_KEY)).toBeNull();
    expect(storedFormatting(localStorage)).toBe(true);
  });

  test("without storage (private window, blocked site data), formatted, and no error", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => storeFormatting(false, localStorage)).not.toThrow();
    expect(storedFormatting(localStorage)).toBe(true);
  });

  test("with no storage given, formatted, and nothing kept", () => {
    storeFormatting(false, undefined);
    expect(storedFormatting(undefined)).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});
