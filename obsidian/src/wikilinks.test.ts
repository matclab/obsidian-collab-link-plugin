// A note's links at the edges of sharing (docs/phase-19-liens.md,
// decisions 1 to 4, 9; ADR-0045 §4): a `[[B]]` to a linked note becomes an
// address without the key; one to this note, `[[#Titre]]`; unlinking
// writes the addresses back as the names of this vault's notes. Pure: the
// names are resolved by the caller (Obsidian's metadataCache).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  applyEdits,
  isRenameRewrite,
  toAddresses,
  toWikilinks,
} from "./wikilinks.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const ORIGIN = "https://collab.test";
const BASE = `${ORIGIN}/`;

/** The vault: notes linked to documents, and this note, "A". */
const NOTES: Record<string, string> = { B: "b", "Travail/C": "c", "D é": "d" };
const resolve = (path: string) =>
  path === "A"
    ? ("self" as const)
    : NOTES[path]
      ? { documentId: NOTES[path] as string, base: BASE }
      : undefined;
const nameOf = (id: string) =>
  Object.entries(NOTES).find(([, doc]) => doc === id)?.[0];

const convert = (text: string) => applyEdits(text, toAddresses(text, resolve));
const back = (text: string) =>
  applyEdits(text, toWikilinks(text, ORIGIN, nameOf));

describe("toAddresses", () => {
  test("a linked note: its address, the name as written or the alias shown, a heading as `h`", () => {
    expect(convert("Vers [[B]], [[B|ici]], [[Travail/C#Plan un]].")).toBe(
      `Vers [B](${ORIGIN}/?doc=b), [ici](${ORIGIN}/?doc=b), [Travail/C#Plan un](${ORIGIN}/?doc=c#h=Plan%20un).`,
    );
  });

  test("this note: `[[#Titre]]`; another note, a block, code: untouched", () => {
    expect(
      convert("[[A#Haut|là]] [[A]] [[Autre]] [[B#^bloc]] `[[B]]` [[#Ici]]"),
    ).toBe("[[#Haut|là]] [[A]] [[Autre]] [[B#^bloc]] `[[B]]` [[#Ici]]");
  });

  test("an alias's backslash, written so that it reads back", () => {
    expect(convert("[[B|a\\b]]")).toBe(`[a\\\\b](${ORIGIN}/?doc=b)`);
  });

  test("only the links asked for", () => {
    const text = "[[B]] [[B|x]]";
    expect(
      applyEdits(
        text,
        toAddresses(text, resolve, (link) => link.from > 0),
      ),
    ).toBe(`[[B]] [x](${ORIGIN}/?doc=b)`);
  });
});

describe("toWikilinks", () => {
  test("an address of a note of this vault: its name, the text an alias unless it is the name", () => {
    expect(
      back(
        `[B](${ORIGIN}/?doc=b) [ici](${ORIGIN}/?doc=b) [Travail/C#Plan](${ORIGIN}/?doc=c#h=Plan) <${ORIGIN}/?doc=d>`,
      ),
    ).toBe("[[B]] [[B|ici]] [[Travail/C#Plan]] [[D é]]");
  });

  test("a document of no note here, another server, a link with its key, a text with brackets: untouched", () => {
    const text = `[x](${ORIGIN}/?doc=z) [x](https://ailleurs.test/?doc=b) [x](${ORIGIN}/?doc=b#k=K&r=edit.S) [a \\[1\\]](${ORIGIN}/?doc=b)`;
    expect(back(text)).toBe(text);
  });
});

describe("there and back (LK3)", () => {
  const PIECES = [
    "a",
    " ",
    "\n",
    "`",
    "[[B]]",
    "[[B|ici]]",
    "[[B|a\\b]]",
    "[[B|*e*]]",
    "[[Travail/C#Plan un]]",
    "[[D é#T|t]]",
    "[[A#Haut]]",
    "[[Autre]]",
    "[[B#^bloc]]",
    "[[#Ici]]",
    "`[[B]]`",
    "[",
    "]",
    "|",
    "#",
  ];

  test("unlinking what sharing wrote gives the text back, `[[A#…]]` written `[[#…]]`", () =>
    hegel.test(
      (tc) => {
        const text = tc
          .draw(gs.arrays(gs.sampledFrom(PIECES), { maxSize: 12 }))
          .join("");
        const shared = convert(text);
        if (shared.includes("#k=") || /[?&#]r=/.test(shared)) {
          throw new Error(`a key in ${JSON.stringify(shared)}`);
        }
        const again = back(shared);
        // This note's own headings stay `[[#…]]`: nothing to write back.
        const wanted = applyEdits(
          text,
          toAddresses(text, (p) => (p === "A" ? "self" : undefined)),
        );
        if (again !== wanted) {
          throw new Error(
            `${JSON.stringify(text)} → ${JSON.stringify(shared)} → ${JSON.stringify(again)}`,
          );
        }
      },
      { testCases: 400 },
    ));
});

/** Whether an offset of `text` is in an indented code block (CommonMark
 * §4.4): a line of four spaces that doesn't go on with a paragraph. Neither
 * a link for Obsidian, nor rewritten when its note is renamed (*Relevé* of
 * choice/obsidian/links/probe-code.mjs). */
function indentedCode(text: string): (at: number) => boolean {
  const lines: [number, number][] = [];
  let paragraph = false;
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    if (line.trim() === "") paragraph = false;
    else if (line.startsWith("    ") && !paragraph) lines.push([start, end]);
    else paragraph = true;
    start = end + 1;
  }
  return (at) => lines.some(([from, to]) => at >= from && at < to);
}

/** A rewrite by the renames is recognized; any other change of the text
 * is not. `tc`: the property's body, and a counter-example's replay. */
const renameScenario = (tc: TC): void => {
  const pieces = tc.draw(
    gs.arrays(
      gs.sampledFrom([
        "a",
        " ",
        // An indented code block, or a paragraph that goes on.
        "    ",
        "[[C]]",
        "[[C|x]]",
        "[[C#T]]",
        "[[B]]",
        "`[[C]]`",
        "\n",
      ]),
      { minSize: 1, maxSize: 8 },
    ),
  );
  const text = pieces.join("");
  // As Obsidian: neither in code, inline nor an indented block.
  const code = indentedCode(text);
  let offset = 0;
  const renamed = pieces
    .map((piece) => {
      const from = offset;
      offset += piece.length;
      return piece.startsWith("[[C") && !code(from)
        ? piece.replace("[[C", "[[D")
        : piece;
    })
    .join("");
  const expected = renamed !== text;
  if (
    isRenameRewrite(text, renamed, [{ from: "C.md", to: "D.md" }]) !== expected
  ) {
    throw new Error(`${JSON.stringify(text)} → ${JSON.stringify(renamed)}`);
  }
  // One more character anywhere: never a rename's.
  const at = tc.draw(gs.integers({ minValue: 0, maxValue: renamed.length }));
  const edited = `${renamed.slice(0, at)}z${renamed.slice(at)}`;
  if (isRenameRewrite(text, edited, [{ from: "C.md", to: "D.md" }])) {
    throw new Error(`taken: ${JSON.stringify(edited)}`);
  }
};

/** `tc` drawing the values recorded, in order. */
function replay(draws: readonly unknown[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("isRenameRewrite (decision 10)", () => {
  const renames = [{ from: "C.md", to: "Archives/D.md" }];
  const before = "Vers [[C]], [[C|un alias]], [[C#Section]] et [[B]].";

  test("the text with only the renamed note's targets rewritten, as Obsidian does", () => {
    for (const after of [
      "Vers [[D]], [[D|un alias]], [[D#Section]] et [[B]].",
      "Vers [[Archives/D]], [[Archives/D|un alias]], [[Archives/D#Section]] et [[B]].",
      "Vers [[D]], [[C|un alias]], [[C#Section]] et [[B]].",
    ]) {
      expect(isRenameRewrite(before, after, renames), after).toBe(true);
    }
  });

  test("anything else, or nothing renamed: not one", () => {
    for (const after of [
      before,
      "Vers [[D]], [[D|autre alias]], [[D#Section]] et [[B]].",
      "Vers [[D]], [[D|un alias]], [[D#Autre]] et [[B]].",
      "Vers [[D]], [[D|un alias]], [[D#Section]] et [[E]].",
      "Vers [[D]], [[D|un alias]], [[D#Section]] et [[B]]!",
      "Avant. Vers [[D]], [[D|un alias]], [[D#Section]] et [[B]].",
      "Vers [[E]], [[D|un alias]], [[D#Section]] et [[B]].",
    ]) {
      expect(isRenameRewrite(before, after, renames), after).toBe(false);
    }
    expect(
      isRenameRewrite(
        before,
        "Vers [[D]], [[D|un alias]], [[D#Section]] et [[B]].",
        [],
      ),
    ).toBe(false);
  });

  test("as Obsidian rewrites, or not, by where the link stands (probe-code.mjs)", () => {
    const renames = [{ from: "C.md", to: "D.md" }];
    // Before, and what Obsidian 1.14 wrote after renaming C to D.
    for (const [before, after] of [
      ["Texte.\n    [[C]]\n", "Texte.\n    [[D]]\n"],
      ["- point\n    [[C]]\n", "- point\n    [[D]]\n"],
      ["[[C]]\n", "[[D]]\n"],
    ] as const) {
      expect(isRenameRewrite(before, after, renames), before).toBe(true);
    }
    // Code — indented, fenced, inline —: left as it was; rewritten, it
    // isn't Obsidian's.
    for (const before of [
      "    [[C]]\n",
      "\t[[C]]\n",
      "Texte.\n\n    [[C]]\n",
      "- point\n\n      [[C]]\n",
      "```\n[[C]]\n```\n",
      "`[[C]]`\n",
    ]) {
      const after = before.replace("[[C]]", "[[D]]");
      expect(isRenameRewrite(before, after, renames), before).toBe(false);
    }
  });

  test("a rewrite by the renames is recognized; any other change of the text is not", () =>
    hegel.test(renameScenario, { testCases: 300 }));

  // Found on 2026-11-01 by `./ci.sh --full` (phase 23, without relation to
  // it; red at 79b40b7 too), kept here rather than only in obsidian/.hegel:
  // four spaces, then `[[C]]` — an indented code block, where Obsidian
  // neither sees a link nor rewrites one (choice/obsidian/links/,
  // probe-code.mjs); the property expected a rewrite.
  test("a counter-example: `[[C]]` in an indented code block", () => {
    const { tc, done } = replay([[" ", " ", " ", " ", "[[C]]"], 0]);
    renameScenario(tc);
    expect(done()).toBe(true);
  });
});
