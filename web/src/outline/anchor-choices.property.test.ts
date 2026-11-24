import { Text } from "@codemirror/state";
// The menu of a link to a heading, against the two readers (phase 20,
// decision 9): each choice, written after `](#` or `[[#`, is one link for
// the editor's parser and for the preview, and both lead to its heading;
// the first heading of each text is offered by its text alone.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { hrefAt } from "../editor/link-click.js";
import { markdownParser } from "../editor/markdown-syntax.js";
import { renderMarkdown } from "../render/index.js";
import { type AnchorForm, anchorChoices } from "./anchor-choices.js";
import { headingForFragment, headingKey } from "./fragment.js";
import { outlineOfText } from "./outline.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const decoded = (href: string) => decodeURIComponent(href.slice(1));

/** The address of the link the test wrote, the last of its kind in the
 * preview's HTML: `<a href>x</a>`, or a `[[…]]`'s; not a footnote's, which
 * the preview adds after the text (a heading may hold `^[…]`). */
function writtenHref(html: string, form: AnchorForm): string | undefined {
  const pattern =
    form === "link"
      ? /<a href="([^"]*)">x<\/a>/g
      : /<a class="md-wikilink" href="([^"]*)">/g;
  return [...html.matchAll(pattern)]
    .at(-1)?.[1]
    ?.replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const headingLines = gs.arrays(
  gs.tuples(
    gs.integers({ minValue: 1, maxValue: 4 }),
    gs.oneOf(
      gs.sampledFrom(["Notes", "Mon titre", "Relevé 19.0", "C# 50%"]),
      gs.text({
        alphabet: "ab é#()[]<>\\&%|^!*_`~: ",
        minSize: 1,
        maxSize: 10,
      }),
    ),
  ),
  { minSize: 1, maxSize: 6 },
);

/** The property, for headings `lines` and links of `form`. */
function checkChoices(
  lines: readonly (readonly [number, string])[],
  form: AnchorForm,
): void {
  const source = lines
    .map(([level, text]) => `${"#".repeat(level)} ${text}`)
    .join("\n\n");
  const outline = outlineOfText(source);
  const choices = anchorChoices(outline, form);
  for (const choice of choices) {
    const link =
      form === "link" ? `[x](#${choice.fragment})` : `[[#${choice.fragment}]]`;
    const text = `${source}\n\n${link}\n`;
    const doc = Text.of(text.split("\n"));
    const at = text.lastIndexOf(link) + 3;
    const editor = hrefAt(markdownParser().parse(text), doc, at);
    check(
      editor !== null &&
        headingForFragment(outline, decoded(editor)) === choice.heading,
      `the editor reads ${JSON.stringify(link)} as ${editor}, in ${JSON.stringify(source)}`,
    );
    if (form === "link") {
      check(
        editor === `#${choice.fragment}`,
        `the editor's link is ${editor}, not #${choice.fragment}`,
      );
    }
    const preview = writtenHref(renderMarkdown(text), form);
    check(
      preview?.startsWith("#") === true &&
        headingForFragment(outline, decoded(preview as string)) ===
          choice.heading,
      `the preview reads ${JSON.stringify(link)} as ${preview}, in ${JSON.stringify(source)}`,
    );
  }
  // A heading that the path of its parents' texts leads to is
  // offered.
  outline.forEach((heading, index) => {
    const parts: string[] = [];
    let level = 7;
    for (let i = index; i >= 0; i--) {
      const each = outline[i] as (typeof outline)[number];
      if (each.level >= level) continue;
      level = each.level;
      parts.unshift(headingKey(each.source));
      if (headingForFragment(outline, parts.join("#")) !== index) continue;
      check(
        choices.some((choice) => choice.heading === index),
        `${JSON.stringify(heading.source)} reached by ${parts.join("#")}, not offered, in ${JSON.stringify(source)}`,
      );
      return;
    }
  });
  // The first heading of each text is offered, by its text alone.
  const seen = new Set<string>();
  outline.forEach((heading, index) => {
    const key = headingKey(heading.source);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    const choice = choices.find((each) => each.heading === index);
    check(
      choice !== undefined && !choice.fragment.includes("#"),
      `${JSON.stringify(heading.source)} offered as ${choice?.fragment}, in ${JSON.stringify(source)}`,
    );
  });
}

describe("the menu of a link to a heading (property)", () => {
  test("each choice is a link both readers follow to its heading", () =>
    hegel.test(
      (tc) =>
        checkChoices(
          tc.draw(headingLines),
          tc.draw(gs.sampledFrom<AnchorForm>(["link", "wikilink"])),
        ),
      { testCases: 400 },
    ));

  // Counter-examples found by Hegel, kept (AGENTS.md, §1.4).
  test("replay: a heading shown as another's raw text, `_:__` before `_`", () => {
    checkChoices(
      [
        [1, "_:__"],
        [1, "_"],
      ],
      "link",
    );
  });
});
