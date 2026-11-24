// @vitest-environment node
// The view's styles stay in the view (phase 14, decision 24): every rule of
// `page.css` is under `.document-view`, so that the plugin can load it in
// Obsidian without changing anything else of the application; what is the
// page's alone is in `page-only.css`, which only `main.ts` imports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const styles = join(import.meta.dirname, "../styles");
const read = (name: string) => readFileSync(join(styles, name), "utf8");

/** The selectors of every style rule, inside at-rules too; at-rules that
 * hold no rules (`@import`, `@font-face`) are returned by name. */
function selectors(css: string): { rules: string[]; atRules: string[] } {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  const atRules: string[] = [];
  const walk = (from: number, to: number) => {
    let at = from;
    while (at < to) {
      const open = text.indexOf("{", at);
      const semi = text.indexOf(";", at);
      if (semi !== -1 && semi < to && (open === -1 || semi < open)) {
        const statement = text.slice(at, semi).trim();
        if (statement.startsWith("@")) atRules.push(statement);
        at = semi + 1;
        continue;
      }
      if (open === -1 || open >= to) return;
      const head = text.slice(at, open).trim();
      let depth = 0;
      let close = open;
      for (; close < to; close++) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}" && --depth === 0) break;
      }
      if (/^@(media|container|supports|layer)\b/.test(head)) {
        walk(open + 1, close);
      } else if (head.startsWith("@")) {
        atRules.push(head);
      } else {
        rules.push(
          ...head
            .split(/,(?![^(]*\))/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
      at = close + 1;
    }
  };
  walk(0, text.length);
  return { rules, atRules };
}

describe("the view's stylesheet", () => {
  test("has every selector under .document-view, and nothing global", () => {
    const { rules, atRules } = selectors(read("page.css"));
    expect(rules.length).toBeGreaterThan(100);
    const outside = rules.filter(
      (s) => !/^(:where\(\.document-view\)|\.document-view)(?![\w-])/.test(s),
    );
    expect(outside).toEqual([]);
    // Under `:where(…)`, which weighs nothing: each rule keeps its weight
    // against the components' styles (a hovered button of the page must not
    // win over the chosen version's). Only the rule that was already the
    // view's own keeps its class.
    expect(
      rules.filter((s) => !s.startsWith(":where(.document-view)")),
    ).toEqual([".document-view:has(.view-editor.side-by-side)"]);
    // No font of the page's own in the view's sheet (decision 25).
    expect(atRules).toEqual([]);
  });

  test("the page's own sheet holds what is the page's, and the reading font", () => {
    const own = read("page-only.css");
    expect(own).toContain('@import "./fonts.css"');
    expect(own).toContain('@import "./page.css"');
  });

  test("finds a selector that escapes, inside an at-rule too", () => {
    const { rules } = selectors(
      ".document-view a, b { x: 1 }\n@container (max-width: 1px) { .c { y: 2 } }",
    );
    expect(rules).toEqual([".document-view a", "b", ".c"]);
  });
});

// The view's width, not the window's (phase 14, decision 26): in a narrow
// pane of Obsidian, the view takes its narrow layout by itself.
describe("the view's layout", () => {
  const sheets = [
    read("page.css"),
    ...[
      "header/Header",
      "history/HistoryView",
      "annotations/AnnotationsPanel",
    ].map((name) =>
      readFileSync(join(import.meta.dirname, `../ui/${name}.svelte`), "utf8"),
    ),
  ];

  test("follows the view's width: no width of the window is asked", () => {
    for (const sheet of sheets) {
      expect(sheet).not.toMatch(/@media[^{]*width/);
    }
    expect(sheets.join("\n")).toMatch(/@container document-view \(max-width/);
  });

  test("the view is the container it asks", () => {
    const view = read("page.css").match(
      /:where\(\.document-view\) \{[^}]*\}/,
    )?.[0];
    expect(view).toContain("container: document-view / inline-size");
  });
});
