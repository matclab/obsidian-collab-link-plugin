// What the menu of a link to a heading offers (phase 20, decision 9): each
// heading the link can lead to, written for the link's form so that it
// leads there, the first match of its text otherwise taken.
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { anchorChoices, anchorMatches } from "./anchor-choices.js";
import { headingForFragment } from "./fragment.js";
import { outlineOfText } from "./outline.js";

const fragments = (text: string, form: "link" | "wikilink") =>
  anchorChoices(outlineOfText(text), form).map((each) => each.fragment);

describe("anchorChoices", () => {
  test("each heading, as Obsidian writes it: its text, spaces %20 in a link", () => {
    const text = "# Mon titre\n\n## Relevé 19.0\n";
    expect(fragments(text, "link")).toEqual(["Mon%20titre", "Relevé%2019.0"]);
    expect(fragments(text, "wikilink")).toEqual(["Mon titre", "Relevé 19.0"]);
  });

  test("its level and its text as shown, for the list", () => {
    const [first, second] = anchorChoices(
      outlineOfText("# Le **gras**\n\n### Trois\n"),
      "link",
    );
    expect(first).toMatchObject({ heading: 0, level: 1, text: "Le gras" });
    expect(second).toMatchObject({ heading: 1, level: 3, text: "Trois" });
  });

  test("what would end or break the link left out: punctuation, which the match ignores", () => {
    const text = "# A (b) <c> & d\n\n# C# 50%\n\n# x | y ^z [w]\n";
    expect(fragments(text, "link")).toEqual([
      "A%20b%20c%20d",
      "C%2050",
      // A | would end a table's cell.
      "x%20y%20^z%20w",
    ]);
    expect(fragments(text, "wikilink")).toEqual([
      "A (b) <c> & d",
      "C 50%",
      "x y z w",
    ]);
  });

  test("a second heading of the same text, by its parent's path", () => {
    const text = "# Un\n\n## Notes\n\n# Deux\n\n## Notes\n";
    expect(fragments(text, "link")).toEqual([
      "Un",
      "Notes",
      "Deux",
      "Deux#Notes",
    ]);
    expect(fragments(text, "wikilink")).toEqual([
      "Un",
      "Notes",
      "Deux",
      "Deux#Notes",
    ]);
  });

  test("a heading no link can reach, not offered", () => {
    // Two top-level headings of one text: the first is taken.
    expect(fragments("# Notes\n\n# Notes\n", "link")).toEqual(["Notes"]);
    // Nothing but punctuation.
    expect(fragments("# !?\n\n# Ok\n", "link")).toEqual(["Ok"]);
  });
});

test("a heading holding a footnote: its link, not the footnote's, leads to it", () => {
  // Found by the property: the preview adds the footnote's own links
  // after the text, the test took the last one for the menu's.
  const text = "# ^[]_";
  const outline = outlineOfText(text);
  const [choice] = anchorChoices(outline, "link");
  expect(choice?.fragment).toBe("^%20_");
  const html = renderMarkdown(`${text}\n\n[x](#${choice?.fragment})\n`);
  const href = /<a href="([^"]*)">x<\/a>/.exec(html)?.[1] ?? "";
  expect(headingForFragment(outline, decodeURIComponent(href.slice(1)))).toBe(
    0,
  );
});

describe("anchorMatches", () => {
  const choices = anchorChoices(
    outlineOfText("# Mon titre\n\n## Relevé 19.0\n\n## Entrée/sortie\n"),
    "link",
  );
  const texts = (query: string) =>
    anchorMatches(choices, query).map((each) => each.text);

  test("all, before anything is typed", () => {
    expect(texts("")).toEqual(["Mon titre", "Relevé 19.0", "Entrée/sortie"]);
  });

  test("those whose text holds what is typed: case, accents and punctuation aside", () => {
    expect(texts("titre")).toEqual(["Mon titre"]);
    expect(texts("RELEVE")).toEqual(["Relevé 19.0"]);
    expect(texts("entree sortie")).toEqual(["Entrée/sortie"]);
    expect(texts("Mon%20t")).toEqual(["Mon titre"]);
    expect(texts("zzz")).toEqual([]);
  });
});
