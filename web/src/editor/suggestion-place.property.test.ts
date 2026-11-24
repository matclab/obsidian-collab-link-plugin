// @vitest-environment jsdom
// A suggestion proposed as a paragraph of its own (phase 24) is one, in
// the preview, and leaves the rest of the text as it was: the editor's
// parser chooses the place, the preview's says what it gives.
import { EditorState, Text } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { additionPlaces, asOwnParagraph } from "./suggestion-place.js";

const LINES = [
  "",
  "",
  "# Title",
  "### Title",
  "Para a",
  "Para b",
  "- item",
  "- [ ] task",
  "1. one",
  "2. two",
  "> quote",
  "> - quoted item",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "```",
  "code",
  "---",
  "  two spaces",
  "    four spaces",
  "Setext",
  "===",
  "[^1]: note",
  // Constructs over several lines, each as one gesture: chance rarely
  // draws their lines in order.
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "```\ncode\n\nmore\n```",
  "Setext\n===",
  "> [!note] Title\n> Callout text.",
  "- item\n  continued\n\n  second paragraph",
  // A formula, whole: a blank line in one ends it for the editor's parser,
  // not the preview's (accepted divergence, ADR-0032 point 10).
  "$$\nx^2\n$$",
];

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const PROPOSED = "Proposed";

function rendered(source: string): string {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(source);
  return root.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function ownParagraph(source: string): boolean {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(source);
  return Array.from(root.children).some(
    (child) => child.tagName === "P" && child.textContent === PROPOSED,
  );
}

/** One case: the property's body, and a counter-example's replay. */
function scenario(tc: TC): void {
  const lines = tc.draw(
    gs.arrays(gs.sampledFrom(LINES), { minSize: 1, maxSize: 8 }),
  );
  const text = lines.join("\n");
  const doc = Text.of(text.split("\n"));
  const line = doc.line(
    tc.draw(gs.integers({ minValue: 1, maxValue: doc.lines })),
  );
  // Accepted divergence (ADR-0032, point 7): a `===` line under a
  // table, no blank line between, a row of it for the preview only.
  tc.assume(!/^\|.*\n(?:.+\n)*===/m.test(text));
  const state = EditorState.create({
    doc: text,
    extensions: markdownSyntax(),
  });
  const places = additionPlaces(state, line.from);
  tc.assume(places !== null);
  if (!places) return;
  const at = places.paragraph;
  const after =
    text.slice(0, at) + asOwnParagraph(doc, at, PROPOSED) + text.slice(at);
  if (!ownParagraph(after)) {
    throw new Error(
      `${JSON.stringify(after)}: no paragraph of its own (${renderMarkdown(after)})`,
    );
  }
  const rest = rendered(after.replace(PROPOSED, ""));
  if (rest !== rendered(text)) {
    throw new Error(
      `${JSON.stringify(text)} at ${at}: ${JSON.stringify(rest)}, was ${JSON.stringify(rendered(text))}`,
    );
  }
}

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails). A case assumed away passes, as
 * for Hegel: the body stops there. */
function replay(draws: readonly unknown[]): TC {
  let next = 0;
  return {
    draw: () => draws[next++],
    assume: () => {},
  } as unknown as TC;
}

describe("a suggestion as a paragraph of its own", () => {
  test(
    "is one in the preview, the rest of the text unchanged",
    () => hegel.test(scenario, { testCases: 400 }),
    60_000,
  );

  // Found by the property while writing it (phase 24), kept here rather
  // than only in web/.hegel/examples: the line after a note's definition,
  // its text for the preview; a formula `$$…$$` across a paragraph's lines,
  // a plain one's and a task's.
  test.each([
    [["[^1]: note", "Para a"], 2],
    [["Para a", "$$\nx^2\n$$"], 3],
    [["- [ ] task", "$$\nx^2\n$$"], 3],
  ])("a counter-example kept: %j, line %i", (lines, line) =>
    scenario(replay([lines, line])),
  );
});
