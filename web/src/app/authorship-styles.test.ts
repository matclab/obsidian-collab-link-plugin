// @vitest-environment node
// Who wrote, its look (ADR-0061): each person's pale tint, and a dotted
// underline in their line's colour, which tells them apart whatever the
// theme; under a highlight, the tint gives way, the underline stays.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(
  join(import.meta.dirname, "../styles/page.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rules whose selector matches `selector`. */
function rules(selector: RegExp): string[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, head = ""]) => selector.test(head.replace(/\s+/g, " ")))
    .map(([, , body = ""]) => body.replace(/\s+/g, " ").trim());
}

const PERSONS = ["1", "2", "3", "4", "5", "6", "7", "8", "unknown"];

describe("who wrote, in the text", () => {
  test("each person has a tint and a line", () => {
    for (const n of PERSONS) {
      const [rule = ""] = rules(new RegExp(`\\.cm-author-${n} $`));
      expect(rule, n).toContain(`--author-line: var(--author-${n}-line)`);
      expect(rule, n).toContain(`--author-tint: var(--author-${n})`);
      expect(rule, n).toContain("background: var(--author-tint)");
    }
  });

  test("the text is underlined, dotted, in its person's line", () => {
    const [rule = ""] = rules(/\.cm-author $/);
    expect(rule).toContain("text-decoration-line: underline");
    expect(rule).toContain("text-decoration-style: dotted");
    expect(rule).toContain("text-decoration-color: var(--author-line)");
    expect(rule).toContain("text-decoration-thickness: 2px");
    // Continuous under the descenders: a person's stretch reads as one.
    expect(rule).toContain("text-decoration-skip-ink: none");
  });

  test("under a highlight, Obsidian's or the page's, the tint gives way", () => {
    const [rule = ""] = rules(
      /:is\(\.cm-highlight, \.cm-md-highlight\) \.cm-author $/,
    );
    expect(rule).toBe("background: none;");
  });
});
