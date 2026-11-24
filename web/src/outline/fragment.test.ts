// A link to a heading, `[t](#x)` (docs/phase-19-liens.md, decision 8):
// after an exact id (the preview's footnotes), the first heading whose
// text matches `x` as Obsidian matches it, ignoring case and punctuation
// (*Relevé 19.0*); else the heading whose GitHub-style id is `x`.

import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { githubSlugs, headingForFragment, headingKey } from "./fragment.js";

const headings = (...texts: string[]) =>
  texts.map((text) => ({ source: text, text }));

describe("headingForFragment", () => {
  const plan = headings("Mon titre", "Titre ponctué !", "Double", "Double");

  test("the heading's text, as Obsidian matches it: case and punctuation aside", () => {
    expect(headingForFragment(plan, "Mon titre")).toBe(0);
    expect(headingForFragment(plan, "mon titre")).toBe(0);
    expect(headingForFragment(plan, "Titre ponctué !")).toBe(1);
    expect(headingForFragment(plan, "Titre ponctué")).toBe(1);
    expect(headingForFragment(plan, "  MON   titre ")).toBe(0);
  });

  test("of two headings of the same text, the first", () => {
    expect(headingForFragment(plan, "Double")).toBe(2);
  });

  test("else the heading's GitHub-style id, a second one numbered", () => {
    expect(headingForFragment(plan, "mon-titre")).toBe(0);
    expect(headingForFragment(plan, "titre-ponctué-")).toBe(1);
    expect(headingForFragment(plan, "double")).toBe(2);
    expect(headingForFragment(plan, "double-1")).toBe(3);
  });

  test("the text first, then the id: a heading written as another's id", () => {
    expect(
      headingForFragment(headings("Mon titre", "mon-titre"), "mon-titre"),
    ).toBe(1);
  });

  test("the raw text or the shown text", () => {
    const formatted = [
      { source: "Titre *mis* `code`", text: "Titre mis code" },
    ];
    expect(headingForFragment(formatted, "Titre mis code")).toBe(0);
    expect(headingForFragment(formatted, "titre-mis-code")).toBe(0);
  });

  test("the raw text before the shown text: `__init__`, shown `init`, doesn't hide `init`", () => {
    const shadowed = [
      { source: "__init__", text: "init", level: 1 },
      { source: "init", text: "init", level: 1 },
      { source: "Parent", text: "Parent", level: 1 },
      { source: "__init__", text: "init", level: 2 },
      { source: "init", text: "init", level: 2 },
    ];
    expect(headingForFragment(shadowed, "init")).toBe(1);
    expect(headingForFragment(shadowed, "__init__")).toBe(0);
    expect(headingForFragment(shadowed, "Parent#init")).toBe(4);
    // Shown only: still found, by its shown text.
    expect(headingForFragment(shadowed.slice(0, 1), "init")).toBe(0);
    expect(headingForFragment(shadowed.slice(2, 4), "Parent#init")).toBe(1);
  });

  test("a path, `Parent#Enfant`: the heading of that text in its parent's section (phase 19, `[[#Parent#Enfant]]`)", () => {
    const nested = [
      { source: "Enfant", text: "Enfant", level: 2 },
      { source: "Parent", text: "Parent", level: 1 },
      { source: "Autre", text: "Autre", level: 2 },
      { source: "Enfant", text: "Enfant", level: 2 },
      { source: "Suite", text: "Suite", level: 1 },
      { source: "Enfant", text: "Enfant", level: 2 },
    ];
    expect(headingForFragment(nested, "Parent#Enfant")).toBe(3);
    expect(headingForFragment(nested, "parent#enfant")).toBe(3);
    expect(headingForFragment(nested, "Suite#Enfant")).toBe(5);
    expect(headingForFragment(nested, "Autre#Enfant")).toBeUndefined();
    expect(headingForFragment(nested, "Parent#Absent")).toBeUndefined();
  });

  test("none when nothing matches, nor for a fragment of punctuation only", () => {
    expect(headingForFragment(plan, "Autre")).toBeUndefined();
    expect(headingForFragment(plan, "")).toBeUndefined();
    expect(headingForFragment(headings("!"), "!")).toBeUndefined();
  });
});

describe("githubSlugs", () => {
  test("as GitHub writes them", () => {
    expect(
      githubSlugs([
        "Mon titre",
        "Titre ponctué !",
        "C'est l'été, 2026 (v2)",
        "snake_case et tiret-ci",
        "Double",
        "Double",
        "Double-1",
        "Double",
      ]),
    ).toEqual([
      "mon-titre",
      "titre-ponctué-",
      "cest-lété-2026-v2",
      "snake_case-et-tiret-ci",
      "double",
      "double-1",
      "double-1-1",
      "double-2",
    ]);
  });

  test("each one different, and each one a fragment that leads to its own heading or to one of the same text", () =>
    hegel.test(
      (tc) => {
        const texts = tc.draw(
          gs.arrays(
            gs.sampledFrom([
              "A",
              "a",
              "A b",
              "a-b",
              "a b!",
              "É",
              "x-1",
              "",
              "!",
            ]),
            { maxSize: 8 },
          ),
        );
        const slugs = githubSlugs(texts);
        if (new Set(slugs).size !== slugs.length) {
          throw new Error(`the same id twice: ${JSON.stringify(slugs)}`);
        }
        const list = headings(...texts);
        slugs.forEach((slug, i) => {
          if (headingKey(slug) === "" && slug === "") return;
          const found = headingForFragment(list, slug);
          if (found === i) return;
          // The text comes first: another heading whose text is this id.
          if (
            found !== undefined &&
            headingKey(texts[found] ?? "") === headingKey(slug)
          )
            return;
          throw new Error(`${JSON.stringify(slug)}: ${found}, not ${i}`);
        });
      },
      { testCases: 300 },
    ));

  test("never throws, whatever the fragment", () =>
    hegel.test(
      (tc) => {
        const list = headings(
          ...tc.draw(gs.arrays(gs.text({ maxSize: 12 }), { maxSize: 5 })),
        );
        headingForFragment(list, tc.draw(gs.text({ maxSize: 20 })));
      },
      { testCases: 300 },
    ));
});
