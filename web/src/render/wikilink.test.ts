// Obsidian's `[[…]]`, read alike by the editor and the preview
// (docs/phase-19-liens.md, decision 7; ADR-0045 §1 and §3): one scanner,
// shared by both parsers, as `highlightColor` is for highlights.

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { readWikilink } from "./wikilink.js";

describe("readWikilink", () => {
  test("a heading of this document, with or without an alias, nested", () => {
    expect(readWikilink("[[#Titre]] après", 0)).toEqual({
      end: 10,
      kind: "heading",
      target: "#Titre",
      alias: null,
      path: ["Titre"],
      shown: "Titre",
    });
    expect(readWikilink("a [[#Titre|ici]]", 2)).toMatchObject({
      end: 16,
      kind: "heading",
      alias: "ici",
      path: ["Titre"],
      shown: "ici",
    });
    expect(readWikilink("[[#Parent#Enfant]]", 0)).toMatchObject({
      kind: "heading",
      path: ["Parent", "Enfant"],
      shown: "Parent#Enfant",
    });
  });

  test("a block, or a note of someone's vault: shown, not followed", () => {
    expect(readWikilink("[[#^bloc]]", 0)).toMatchObject({
      kind: "block",
      shown: "^bloc",
    });
    expect(readWikilink("[[Note]]", 0)).toMatchObject({
      kind: "note",
      target: "Note",
      shown: "Note",
    });
    expect(readWikilink("[[Note#Titre|vers]]", 0)).toMatchObject({
      kind: "note",
      target: "Note#Titre",
      alias: "vers",
      shown: "vers",
    });
    expect(readWikilink("[[Note|]]", 0)).toMatchObject({
      alias: null,
      shown: "Note",
    });
  });

  test("the first `]]` closes it; `]]]` leaves a bracket after it", () => {
    expect(readWikilink("[[a]]]", 0)?.end).toBe(5);
  });

  test("none: an embed, an empty target, a bracket inside, a line break, unclosed, not at `[[`", () => {
    for (const [text, at] of [
      ["![[Note]]", 1],
      ["[[]]", 0],
      ["[[|alias]]", 0],
      ["[[ ]]", 0],
      ["[[#]]", 0],
      ["[[#a##b]]", 0],
      ["[[a]b]]", 0],
      ["[[a[b]]", 0],
      ["[[a\nb]]", 0],
      ["[[a]", 0],
      ["[a]]", 0],
      ["x[[a]]", 0],
    ] as const) {
      expect(readWikilink(text, at), JSON.stringify(text)).toBeNull();
    }
  });

  test("what it reads is between `[[` and `]]`, and what it shows is its alias or its target", () =>
    hegel.test(
      (tc) => {
        // `[[` where it is read, most of the time: elsewhere, nothing is.
        const before = tc.draw(gs.text({ alphabet: "!a[", maxSize: 2 }));
        const after = tc.draw(
          gs.text({ alphabet: "[]|#^!a b\n", maxSize: 14 }),
        );
        const text = `${before}[[${after}`;
        const at = before.length;
        const found = readWikilink(text, at);
        if (!found) return;
        const inner = text.slice(at + 2, found.end - 2);
        if (
          text.slice(at, at + 2) !== "[[" ||
          text.slice(found.end - 2, found.end) !== "]]"
        ) {
          throw new Error(`not between [[ and ]]: ${JSON.stringify(text)}`);
        }
        if (/[[\]\n]/.test(inner))
          throw new Error(`inside: ${JSON.stringify(inner)}`);
        if (
          found.alias !== null &&
          inner !== `${found.target}|${found.alias}`
        ) {
          throw new Error(`alias: ${JSON.stringify(inner)}`);
        }
        const shown =
          found.alias ??
          (found.target.startsWith("#") ? found.target.slice(1) : found.target);
        if (found.shown !== shown) {
          throw new Error(`shown: ${JSON.stringify(found)}`);
        }
      },
      { testCases: 400 },
    ));
});
