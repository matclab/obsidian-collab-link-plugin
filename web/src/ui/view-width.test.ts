// @vitest-environment jsdom
// The view's width (phase 14, decision 26): narrow and wide follow the
// view's element, not the window — a narrow pane of Obsidian is narrow.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { viewWidths } from "./view-width.js";

/** A ResizeObserver the test drives: `resize(width)` reports a width. */
class FakeObserver {
  static all: FakeObserver[] = [];
  observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  disconnect() {
    this.observed = [];
  }
  unobserve() {}
  resize(width: number) {
    for (const target of this.observed) {
      this.callback(
        [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.fontSize = "";
  FakeObserver.all = [];
});

describe("the view's widths", () => {
  test("narrow up to 56.25 rem, wide from 75 rem, of the view's element", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const element = document.createElement("div");
    const widths = viewWidths(element);
    const observer = FakeObserver.all[0];
    expect(observer?.observed).toEqual([element]);
    for (const [width, narrow, wide] of [
      [390, true, false],
      [900, true, false],
      [901, false, false],
      [1199, false, false],
      [1200, false, true],
      [1440, false, true],
    ] as const) {
      observer?.resize(width);
      expect(widths.narrow.matches(), `${width}`).toBe(narrow);
      expect(widths.wide.matches(), `${width}`).toBe(wide);
    }
  });

  // In rem, as `page.css` asks them: a reader who enlarged the browser's
  // text gets the narrow view sooner (AGENTS.md, §3).
  test("in rem: a larger text of the browser moves the bounds", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    document.documentElement.style.fontSize = "20px";
    const widths = viewWidths(document.createElement("div"));
    const observer = FakeObserver.all[0];
    for (const [width, narrow, wide] of [
      [1000, true, false],
      [1125, true, false],
      [1126, false, false],
      [1499, false, false],
      [1500, false, true],
    ] as const) {
      observer?.resize(width);
      expect(widths.narrow.matches(), `${width}`).toBe(narrow);
      expect(widths.wide.matches(), `${width}`).toBe(wide);
    }
  });

  // The styles ask the same bound as `viewWidths`, in rem.
  test("every @container of the styles asks the narrow bound, 56.25 rem, or the wide one, 75 rem", () => {
    const src = join(import.meta.dirname, "..");
    const conditions = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(css|svelte)$/.test(f))
      .flatMap((f) =>
        Array.from(
          readFileSync(join(src, f), "utf8").matchAll(
            /@container\s+document-view\s*([^{]*)\{/g,
          ),
          (m) => m[1]?.trim(),
        ),
      );
    expect(conditions.length).toBeGreaterThan(3);
    expect(
      conditions.filter(
        (c) =>
          c !== "(max-width: 56.25rem)" &&
          c !== "(width > 56.25rem)" &&
          c !== "(min-width: 75rem)",
      ),
    ).toEqual([]);
  });

  test("tells only when a width crosses its bound", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const widths = viewWidths(document.createElement("div"));
    const narrow = vi.fn();
    const wide = vi.fn();
    widths.narrow.onChange(narrow);
    widths.wide.onChange(wide);
    const observer = FakeObserver.all[0];
    observer?.resize(1440);
    observer?.resize(1300);
    expect(narrow).toHaveBeenCalledTimes(0);
    expect(wide).toHaveBeenCalledTimes(1);
    observer?.resize(800);
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(wide).toHaveBeenCalledTimes(2);
  });

  test("closed, it observes nothing more", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const widths = viewWidths(document.createElement("div"));
    widths.close();
    expect(FakeObserver.all[0]?.observed).toEqual([]);
  });

  test("without ResizeObserver (jsdom), neither narrow nor wide", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const widths = viewWidths(document.createElement("div"));
    expect(widths.narrow.matches()).toBe(false);
    expect(widths.wide.matches()).toBe(false);
    widths.close();
  });
});
