import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  keyedWidth,
  storedWidth,
  widthFromPixels,
} from "./outline-width.js";

describe("the outline's width (ADR-0062, PV1, PV2)", () => {
  test("15 rem by default, between 12 and 28", () => {
    expect([
      MIN_OUTLINE_WIDTH,
      DEFAULT_OUTLINE_WIDTH,
      MAX_OUTLINE_WIDTH,
    ]).toEqual([12, 15, 28]);
  });

  // The column's left edge is placed from it (page.css): the same width.
  test("the style's default width is this one", () => {
    const css = readFileSync(
      join(import.meta.dirname, "../../styles/page.css"),
      "utf8",
    );
    expect(css).toMatch(
      new RegExp(`--outline-width-default: ${DEFAULT_OUTLINE_WIDTH}rem;`),
    );
  });

  test("a width kept is read back; anything unreadable or out of bounds is ignored", () => {
    expect(storedWidth("18")).toBe(18);
    expect(storedWidth("12")).toBe(12);
    expect(storedWidth("28")).toBe(28);
    expect(storedWidth("16.5")).toBe(16.5);
    for (const kept of [
      null,
      "",
      "wide",
      "11.9",
      "28.1",
      "NaN",
      "Infinity",
      "1e3",
      " 18",
      "18rem",
    ])
      expect(storedWidth(kept)).toBeUndefined();
  });

  test("a pointer's distance in pixels, in rem, rounded to a quarter, within bounds", () => {
    expect(widthFromPixels(288, 16)).toBe(18);
    expect(widthFromPixels(290, 16)).toBe(18.25);
    expect(widthFromPixels(100, 16)).toBe(MIN_OUTLINE_WIDTH);
    expect(widthFromPixels(1000, 16)).toBe(MAX_OUTLINE_WIDTH);
    expect(widthFromPixels(360, 20)).toBe(18);
  });

  test("keys: arrows by one rem, Home and End the bounds, Enter the default, others nothing", () => {
    expect(keyedWidth(18, "ArrowRight")).toBe(19);
    expect(keyedWidth(18, "ArrowLeft")).toBe(17);
    expect(keyedWidth(27.5, "ArrowRight")).toBe(MAX_OUTLINE_WIDTH);
    expect(keyedWidth(12.5, "ArrowLeft")).toBe(MIN_OUTLINE_WIDTH);
    expect(keyedWidth(18, "Home")).toBe(MIN_OUTLINE_WIDTH);
    expect(keyedWidth(18, "End")).toBe(MAX_OUTLINE_WIDTH);
    expect(keyedWidth(18, "Enter")).toBe(DEFAULT_OUTLINE_WIDTH);
    expect(keyedWidth(18, "ArrowUp")).toBeUndefined();
    expect(keyedWidth(18, "a")).toBeUndefined();
  });
});
