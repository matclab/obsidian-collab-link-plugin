// Obsidian's `[[…]]` in the editor's parser (phase 19, decision 7): the
// same scanner as the preview's rule (`render/wikilink.ts`), its parts as
// nodes, for the live formatting to hide its markup.
import { describe, expect, test } from "vitest";
import { markdownParser } from "./markdown-syntax.js";

/** Each node of `text` named Wikilink…, as `name from-to "text"`. */
function wikilinkNodes(text: string): string[] {
  const out: string[] = [];
  markdownParser()
    .parse(text)
    .iterate({
      enter: (node) => {
        if (node.name.startsWith("Wikilink"))
          out.push(
            `${node.name} ${node.from}-${node.to} ${JSON.stringify(text.slice(node.from, node.to))}`,
          );
      },
    });
  return out;
}

describe("the editor's parser reads [[…]]", () => {
  test("its marks, its target, its alias", () => {
    expect(wikilinkNodes("a [[#Titre|ici]] b")).toEqual([
      'Wikilink 2-16 "[[#Titre|ici]]"',
      'WikilinkMark 2-4 "[["',
      'WikilinkTarget 4-10 "#Titre"',
      'WikilinkMark 10-11 "|"',
      'WikilinkAlias 11-14 "ici"',
      'WikilinkMark 14-16 "]]"',
    ]);
    expect(wikilinkNodes("[[Note]]")).toEqual([
      'Wikilink 0-8 "[[Note]]"',
      'WikilinkMark 0-2 "[["',
      'WikilinkTarget 2-6 "Note"',
      'WikilinkMark 6-8 "]]"',
    ]);
  });

  test("an empty alias: its bar a mark, no alias", () => {
    expect(wikilinkNodes("[[Note|]]")).toEqual([
      'Wikilink 0-9 "[[Note|]]"',
      'WikilinkMark 0-2 "[["',
      'WikilinkTarget 2-6 "Note"',
      'WikilinkMark 6-7 "|"',
      'WikilinkMark 7-9 "]]"',
    ]);
  });

  test("in a quote, a list, a link's text, a callout's title", () => {
    for (const text of [
      "> [[a]]",
      "- [[a]]",
      "[x [[a]] y](https://e.org)",
      "> [!note] [[a]]",
    ]) {
      expect(wikilinkNodes(text)[0], text).toMatch(
        /^Wikilink \d+-\d+ "\[\[a\]\]"$/,
      );
    }
  });

  test("none: an embed, an empty one, across lines, in code, escaped", () => {
    for (const text of [
      "![[a]]",
      "[[]]",
      "[[ ]]",
      "[[a\nb]]",
      "`[[a]]`",
      "\\[[a]]",
    ]) {
      expect(wikilinkNodes(text), text).toEqual([]);
    }
  });
});
