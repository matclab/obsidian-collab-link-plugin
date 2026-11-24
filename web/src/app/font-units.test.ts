// @vitest-environment node
// Font sizes in rem or em, never in px (AGENTS.md, §3): a size in px
// ignores the text size the reader chose for the browser, a size in rem
// follows it. In the view's stylesheets, the components' styles, the
// editor's themes and the plugin's sheet.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const web = join(import.meta.dirname, "../..");
const sources = [join(web, "src"), join(web, "../obsidian/src")];

/** A font size in px: `font-size: 15px`, `font: 15px / 1.5 …`, or a
 * CodeMirror theme's `fontSize: "15px"`. */
const PX_FONT =
  /font(-size)?\s*:[^;{}]*?\b\d+(\.\d+)?px|fontSize\s*:\s*["'`][^"'`]*\d+(\.\d+)?px/g;

function files(): string[] {
  return sources.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(css|svelte|ts)$/.test(f) && !/\.test\.ts$/.test(f))
      .map((f) => join(dir, f)),
  );
}

/** Each font size in px of `text`, with its line. */
function pxFontSizes(text: string): string[] {
  return Array.from(text.matchAll(PX_FONT), (m) => {
    const line = text.slice(0, m.index).split("\n").length;
    return `${line}: ${m[0]}`;
  });
}

describe("font sizes", () => {
  test("the pattern finds each way of writing one in px, and nothing else", () => {
    expect(pxFontSizes("a { font-size: 15px; }")).toHaveLength(1);
    expect(pxFontSizes("a {\n  font: 15px / 1.5 var(--font-doc);\n}")).toEqual([
      "2: font: 15px",
    ]);
    expect(pxFontSizes('".cm-x": { fontSize: "13px" }')).toHaveLength(1);
    expect(
      pxFontSizes("a { font-size: 0.9375rem; border: 1px solid; }"),
    ).toEqual([]);
    expect(
      pxFontSizes("a { font: var(--font-ui-size) / 1.45 var(--font-ui); }"),
    ).toEqual([]);
    expect(pxFontSizes('{ fontSize: "0.9em", padding: "2px" }')).toEqual([]);
  });

  test("are never in px, in the view, the editor or the plugin", () => {
    const all = files();
    expect(all.length).toBeGreaterThan(100);
    const found = all.flatMap((f) =>
      pxFontSizes(readFileSync(f, "utf8")).map(
        (m) => `${relative(web, f)}:${m}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
