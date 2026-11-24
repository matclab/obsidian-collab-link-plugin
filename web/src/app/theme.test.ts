// @vitest-environment node
// The dark theme (phase 10g): the system's preference; every color token
// of the light theme has its dark value, so that nothing light is left on
// a dark page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CALLOUT_FAMILIES, HIGHLIGHT_COLORS } from "../render/index.js";

const css = readFileSync(
  join(import.meta.dirname, "../styles/page.css"),
  "utf8",
);

/** The custom properties a block declares. */
function tokens(block: string): Set<string> {
  return new Set(
    Array.from(block.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1] ?? ""),
  );
}

/** The text between the braces that follow `start`. */
function blockAfter(start: number): string {
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

describe("the page's themes", () => {
  test("the dark one redefines every color token of the light one", () => {
    const tokensAt = css.indexOf(":where(.document-view) {");
    expect(tokensAt).toBeGreaterThanOrEqual(0);
    const light = tokens(blockAfter(tokensAt));
    const colors = [...light].filter(
      (name) =>
        !/^--(font|radius|column|text-inset|margin-width|outline-width|narrow)/.test(
          name,
        ),
    );
    expect(colors.length).toBeGreaterThan(10);
    const at = css.indexOf("@media (prefers-color-scheme: dark)");
    expect(at).toBeGreaterThan(0);
    const dark = tokens(blockAfter(at));
    expect(colors.filter((name) => !dark.has(name))).toEqual([]);
  });

  test("each callout family has its colour, in both themes, and the preview's callouts take it (phase 15, decision 8)", () => {
    const light = tokens(blockAfter(css.indexOf(":where(.document-view) {")));
    expect(CALLOUT_FAMILIES).toHaveLength(13);
    for (const family of CALLOUT_FAMILIES) {
      expect(light.has(`--md-callout-${family}`), family).toBe(true);
      expect(css, family).toMatch(
        new RegExp(
          `\\.md-callout-${family}[^{]*\\{[^}]*--md-callout:\\s*var\\(--md-callout-${family}\\)`,
        ),
      );
    }
  });

  // ADR-0044: a highlight's background, the default and each color's.
  // The preview's marks and an annotation's text's (ADR-0047).
  test("each highlight color has its tint, in both themes, and the preview's and annotations' marks take it", () => {
    const light = tokens(blockAfter(css.indexOf(":where(.document-view) {")));
    expect(light.has("--md-highlight")).toBe(true);
    expect(css).toMatch(
      /:is\(\.preview, \.card-text\) mark\s*\{[^}]*background:\s*var\(--md-highlight\)/,
    );
    const colors = Object.values(HIGHLIGHT_COLORS);
    expect(colors).toHaveLength(6);
    for (const color of colors) {
      expect(light.has(`--md-highlight-${color}`), color).toBe(true);
      expect(css, color).toMatch(
        new RegExp(
          `:is\\(\\.preview, \\.card-text\\) mark\\.md-highlight-${color}[^{]*\\{[^}]*background:\\s*var\\(--md-highlight-${color}\\)`,
        ),
      );
    }
  });

  // An opaque tint would cover a callout's, a code block's, a highlight's
  // background: on a note's, the selection's was the same blue.
  test("the editor's selection darkens what it covers, in both themes", () => {
    expect(css).toMatch(
      /\.cm-content ::selection\s*\{[^}]*background:\s*var\(--selection\)/,
    );
    const light = blockAfter(css.indexOf(":where(.document-view) {"));
    const dark = blockAfter(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const block of [light, dark]) {
      expect(block).toMatch(/--selection:\s*rgb\([\d\s]+\/\s*0\.\d+\)/);
    }
  });

  test("motion is reduced when the system asks", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
