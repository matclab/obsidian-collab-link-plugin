// Moving a section (phase 17, decision 7), in properties, on documents of
// headings of three levels (ATX and setext), bodies with lists, blank
// lines and fenced code holding a `#` (not a heading), with or without a
// final line break, the caret anywhere: moved, then moved back, the text
// is the same; the blank lines between sections stay where they were; nothing
// outside the two sections changes; no heading is lost or added;
// the section is where it says.
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  type Direction,
  type SectionMove,
  moveSection,
} from "./move-section.js";
import { outlineOfText } from "./outline.js";

const BODIES = [
  "```\nouvert, jamais fermé\n",
  "",
  "texte\n",
  "\n",
  "- un\n- deux\n",
  "```\n# pas un titre\n```\n",
  "\n\nfin\n",
];

function document(tc: TestCase): string {
  const preamble = tc.draw(gs.sampledFrom(["", "Avant.\n\n"]));
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 7 }));
  let text = preamble;
  for (let i = 0; i < count; i++) {
    const level = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    const setext = level <= 2 && tc.draw(gs.booleans());
    // A setext heading after a paragraph would continue it: after a blank
    // line, as one writes it.
    text += setext
      ? `\nT${i}\n${level === 1 ? "===" : "---"}\n`
      : `${"#".repeat(level)} T${i}\n`;
    text += tc.draw(gs.sampledFrom(BODIES));
  }
  return tc.draw(gs.booleans()) ? text : text.replace(/\n$/, "");
}

function apply(text: string, move: SectionMove): string {
  let result = text;
  for (const change of [...move.changes].sort((a, b) => b.from - a.from)) {
    result =
      result.slice(0, change.from) +
      change.insert +
      result.slice(change.to ?? change.from);
  }
  return result;
}

const headingsOf = (text: string) =>
  outlineOfText(text)
    .map((heading) => `${heading.level} ${heading.source}`)
    .sort();

describe("moving a section (property)", () => {
  test(
    "moved and moved back, the same text; nothing else changes; the headings kept",
    () =>
      hegel.test(
        (tc) => {
          const text = document(tc);
          const pos = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length }),
          );
          const direction = tc.draw(gs.sampledFrom(["up", "down"] as const));
          const move = moveSection(text, outlineOfText(text), pos, direction);
          if (!move) return;
          const after = apply(text, move);
          const fail = (what: string) => {
            throw new Error(
              `${what}: ${JSON.stringify(text)} → ${JSON.stringify(after)}`,
            );
          };
          if (headingsOf(after).join("|") !== headingsOf(text).join("|")) {
            fail("headings lost or added");
          }
          // Outside the two sections, nothing changes.
          const touched = move.changes.flatMap((c) => [c.from, c.to ?? c.from]);
          const low = Math.min(...touched);
          const high = Math.max(...touched);
          if (!after.startsWith(text.slice(0, low))) fail("changed before");
          if (!after.endsWith(text.slice(high))) fail("changed after");
          // The section starts where it says, a heading there.
          const moved = outlineOfText(after).find(
            (h) => h.from === move.headingAt,
          );
          if (!moved) fail(`no heading at ${move.headingAt}`);
          // The blank lines before each heading of its level or above, in
          // order, stay where they were.
          const gaps = (t: string) =>
            outlineOfText(t)
              .filter((h) => h.level <= (moved?.level ?? 0))
              .map((h) => /\n(?:[ \t]*\n)*$/.exec(t.slice(0, h.from))?.[0])
              .join("|");
          if (gaps(after) !== gaps(text)) fail("blank lines moved");
          const back: Direction = direction === "up" ? "down" : "up";
          const undo = moveSection(
            after,
            outlineOfText(after),
            move.headingAt,
            back,
          );
          if (!undo) fail("can't be moved back");
          else {
            const back = apply(after, undo);
            if (back !== text) fail(`moved back: ${JSON.stringify(back)}`);
          }
        },
        { testCases: 1000 },
      ),
    60_000,
  );
});
