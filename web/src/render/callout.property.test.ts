// @vitest-environment jsdom
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { calloutHeader } from "./callout.js";
import { renderMarkdown } from "./render.js";

// A quote's first line, near a callout's header or one, then lines that
// continue the quote, lazily or not, nest, or leave it.
const BEFORE = [">", "> ", ">  ", ">\t", "   > ", "> > "];
const TYPES = [
  "note",
  "Warning",
  "Mon Type",
  "a|m",
  '"<x',
  "été",
  "",
  " ",
  "a]b",
];
const SIGNS = ["", "+", "-", "++"];
const TITLES = ["", " ", " T", " *e* `c`", "x", " - x", " [!tip] y", " $t$"];
const LINES = [
  "> x",
  "> *y* z",
  ">",
  "lazy",
  "> - item",
  "> > [!tip] in",
  "> > q",
  ">\n> $$\n> m\n> $$",
  "> # h",
  "",
  "after",
];

const text = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return (template.content.textContent ?? "").replace(/\s+/g, "");
};

describe("callouts (property)", () => {
  test(
    "a callout where its header is, and none of the text lost, moved into the title or doubled",
    () =>
      hegel.test(
        (tc) => {
          const [before, type, sign, title] = [
            BEFORE,
            TYPES,
            SIGNS,
            TITLES,
          ].map((choices) => tc.draw(gs.sampledFrom(choices)));
          const first = `${before}[!${type}]${sign}${title}`;
          const rest = tc.draw(
            gs.arrays(gs.sampledFrom(LINES), { maxSize: 6 }),
          );
          // A blank `>` line first: the header is not on the quote's first
          // line, no callout (as Obsidian, essai 15e.2).
          const blank = tc.draw(gs.booleans());
          const source = [...(blank ? [">"] : []), first, ...rest].join("\n");
          const html = renderMarkdown(source);
          const template = document.createElement("template");
          template.innerHTML = html;
          const top = template.content.firstElementChild;
          // `> > ` opens a quote holding the callout.
          const callout = top?.matches("blockquote")
            ? top.firstElementChild
            : top;
          // After a blank line, only a quote opened on the header's line
          // (`> > `) still starts with it.
          const header =
            blank && !/>.*>/.test(before ?? "") ? null : calloutHeader(first);
          const fail = (why: string) => {
            throw new Error(
              `${why}\nsource=${JSON.stringify(source)}\nhtml=${html}`,
            );
          };
          if (Boolean(header) !== Boolean(callout?.matches(".md-callout"))) {
            fail(header ? "no callout" : "a callout without a header");
          }
          if (!header || !callout) return;
          // The same document, its header a word that opens the same
          // paragraph, without a callout.
          const plain = [`${first.slice(0, header.at)}Z`, ...rest].join("\n");
          const shown = callout.querySelector(":scope > .md-callout-title");
          if (
            text(html) !==
            (shown?.textContent ?? "").replace(/\s+/g, "") +
              text(renderMarkdown(plain)).replace("Z", "")
          ) {
            fail("the text changed");
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
