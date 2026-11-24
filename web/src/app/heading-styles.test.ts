// @vitest-environment node
// The headings' levels, told apart (phase 20, user feedback): one look per
// level, the same in the page's editor and in its preview, from one rule
// each in `page-only.css` — the plugin keeps its theme's headings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", path), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
const LEVELS = [1, 2, 3, 4, 5, 6];

/** The declarations of the rules whose selector names `.preview hN`. */
function previewRules(css: string, level: number): string[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map(([, head = "", body = ""]) => `${head.trim()} { ${body.trim()} }`)
    .filter((rule) => new RegExp(`\\.preview h${level}\\b[^{]*\\{`).test(rule));
}

describe("the headings' look", () => {
  test("is the page's alone: the view's sheet, loaded by the plugin, has none", () => {
    for (const level of LEVELS) {
      expect(previewRules(read("styles/page.css"), level)).toEqual([]);
    }
  });

  test("is one rule per level, for the preview and the editor alike", () => {
    const own = read("styles/page-only.css");
    for (const level of LEVELS) {
      const shared = previewRules(own, level).filter(
        (rule) =>
          rule.includes(`.cm-line.cm-live-h${level}`) &&
          /font(-size)?:/.test(rule),
      );
      expect(shared).toHaveLength(1);
    }
  });

  test("the editor's theme sets no heading of its own", () => {
    expect(read("editor/live-preview.ts")).not.toMatch(/\.cm-live-h\d/);
  });
});
