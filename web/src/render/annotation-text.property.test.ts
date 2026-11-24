// @vitest-environment jsdom
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { renderAnnotationText } from "./annotation-text.js";
import { leavingHref } from "./render.js";
import { hostileMarkdown } from "./test-support/hostile-markdown.js";

/** ADR-0047 §8: each element allowed, and its attributes with the values
 * each may take. */
const ALLOWED: Record<string, Record<string, RegExp>> = {
  p: {},
  br: {},
  em: {},
  strong: {},
  s: {},
  mark: { class: /^md-highlight-[a-z]+$/ },
  code: { class: /^language-/ },
  pre: {},
  ul: {},
  ol: { start: /^\d+$/ },
  li: {},
  blockquote: {},
  a: {
    href: /^/,
    target: /^_blank$/,
    rel: /^noopener noreferrer$/,
    class: /^remote-image$/,
  },
};

/** Why this HTML breaks MA1 or MA2, or undefined if it doesn't. */
function breach(html: string): string | undefined {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const element of Array.from(body.querySelectorAll("*"))) {
    const name = element.localName;
    const allowed = ALLOWED[name];
    if (!allowed) return `element <${name}>`;
    for (const { name: attribute, value } of Array.from(element.attributes)) {
      if (!allowed[attribute]?.test(value)) {
        return `attribute ${attribute}="${value}" on <${name}>`;
      }
    }
    const href = element.getAttribute("href");
    if (name === "a" && (href === null || leavingHref(href) !== href)) {
      return `href ${href}`;
    }
  }
  return undefined;
}

/** The lines a reader sees: a `<br>` or a block's end ends one, a raw line
 * break is a space, spaces collapse. */
function shownLines(html: string): string[] {
  const body = new DOMParser().parseFromString(
    html.replace(/<br>|<\/p>/g, " $&"),
    "text/html",
  ).body;
  return lines((body.textContent ?? "").replace(/\n/g, " "), " ");
}

function lines(text: string, separator: string): string[] {
  return text
    .split(separator)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

// Nothing in it a Markdown construction reads (MA3): no ` * _ ~ = ` [ ] (
// ) < > # ! $ & \ - + `; a digit then `.` at a line's start is left out.
const PLAIN = "abcXYZ 019.,;:?'\"/%@{}|^é€😀\t";

describe("renderAnnotationText (property)", () => {
  test(
    "MA1, MA2: no exception, only the allowed tags and attributes, every link leaving the document",
    () =>
      hegel.test(
        (tc) => {
          const source = hostileMarkdown(tc);
          const html = renderAnnotationText(source);
          const found = breach(html);
          if (found) {
            throw new Error(
              `${found}\nsource=${JSON.stringify(source)}\nhtml=${html}`,
            );
          }
        },
        { testCases: 500 },
      ),
    60_000,
  );

  test("MA1: no exception on arbitrary text", () =>
    hegel.test((tc) => {
      renderAnnotationText(tc.draw(gs.text({ maxSize: 200 })));
    }));

  test("MA3: a text with no markup shows as written, line for line", () =>
    hegel.test((tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const text = Array.from({ length: count }, () =>
        tc.draw(
          gs.text({ alphabet: PLAIN, maxSize: 20 }).filter(
            // Up to three spaces before a paragraph's line are dropped,
            // as everywhere; four make a code block.
            (line) => !/^\s*\d+\./.test(line) && !/^( {4}|\t| *\t)/.test(line),
          ),
        ),
      ).join("\n");
      const shown = shownLines(renderAnnotationText(text));
      const written = lines(text, "\n");
      if (JSON.stringify(shown) !== JSON.stringify(written)) {
        throw new Error(
          `text=${JSON.stringify(text)}\nshown=${JSON.stringify(shown)}`,
        );
      }
    }));
});
