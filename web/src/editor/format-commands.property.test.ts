import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
// The formatting commands' properties (phase 20, WA2, WA3): a toggle
// flips the construction, twice it gives the text back.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { SyntaxNode } from "@lezer/common";
import { describe, test } from "vitest";
import {
  type ConstructId,
  type InlineConstruct,
  construct,
} from "./constructs.js";
import { constructActive, constructTransaction } from "./format-commands.js";
import { markdownSyntax } from "./markdown-syntax.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const INLINE: ConstructId[] = [
  "bold",
  "italic",
  "strikethrough",
  "highlight",
  "code",
];

/** A text of pieces: words of `letters`, and the spaces and line breaks
 * between them — a text drawn letter by letter rarely holds two
 * paragraphs, or a word next to a mark. */
function stateWith(tc: hegel.TestCase, letters: string): EditorState {
  const pieces = tc.draw(
    gs.arrays(
      gs.oneOf(
        gs.text({ minSize: 1, maxSize: 3, alphabet: letters }),
        gs.sampledFrom([" ", "\n", "\n\n"]),
      ),
      { maxSize: 8 },
    ),
  );
  const text = pieces.join("");
  const anchor = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
  const head = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdownSyntax()],
  });
}

function shown(state: EditorState): string {
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return JSON.stringify(
    `${text.slice(0, from)}⟨${text.slice(from, to)}⟩${text.slice(to)}`,
  );
}

/** The nodes named `name` in the text, by the editor's parser. */
function nodesOf(state: EditorState, name: string): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  tree?.iterate({
    enter(node) {
      if (node.name === name) nodes.push(node.node);
    },
  });
  return nodes;
}

describe("inline constructs (property)", () => {
  test(
    "a toggle flips the construction at the selection",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(gs.sampledFrom(INLINE));
          const before = stateWith(tc, "ab*_~=`");
          const spec = constructTransaction(before, id);
          if (!spec) return;
          const after = before.update(spec).state;
          check(
            constructActive(after, id) !== constructActive(before, id),
            `${id}: ${shown(before)} → ${shown(after)}`,
          );
        },
        { testCases: 400 },
      ),
    20_000,
  );

  test(
    "twice on a plain text gives it back, selection included",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(gs.sampledFrom(INLINE));
          const before = stateWith(tc, "ab");
          // Four spaces open a code block: nothing is formatted there.
          if (/^ {4}/m.test(before.doc.toString())) return;
          const once = constructTransaction(before, id);
          const { from, to } = before.selection.main;
          const blank = from < to && before.sliceDoc(from, to).trim() === "";
          check(blank === (once === null), `${id}: ${shown(before)} refused`);
          if (!once) return;
          const middle = before.update(once).state;
          const twice = constructTransaction(middle, id);
          check(twice !== null, `${id}: ${shown(middle)} not toggled back`);
          const after = middle.update(twice ?? {}).state;
          check(
            shown(after) === shown(before),
            `${id}: ${shown(before)} → ${shown(middle)} → ${shown(after)}`,
          );
        },
        { testCases: 400 },
      ),
    20_000,
  );

  // The words the selection touches may be taken in whole, when the
  // marks around the selection alone would not read (`*==*aa`).
  test(
    "outside the selection, its words and the nodes it touches, nothing changes construction",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(gs.sampledFrom(INLINE));
          const it = construct(id) as InlineConstruct;
          const before = stateWith(tc, "ab*_~=`");
          const spec = constructTransaction(before, id);
          if (!spec) return;
          const tr = before.update(spec);
          const after = tr.state;
          const text = before.doc.toString();
          let { from, to } = before.selection.main;
          while (from > 0 && /[ab]/.test(text[from - 1] ?? "")) from--;
          while (to < text.length && /[ab]/.test(text[to] ?? "")) to++;
          const touched = nodesOf(before, it.node).filter(
            (node) => node.from <= to && from <= node.to,
          );
          const inside = (state: EditorState, pos: number) =>
            nodesOf(state, it.node).some(
              (node) => node.from <= pos && pos < node.to,
            );
          for (let pos = 0; pos < before.doc.length; pos++) {
            if (pos >= from - it.mark.length && pos < to + it.mark.length)
              continue;
            if (touched.some((node) => node.from <= pos && pos < node.to))
              continue;
            const mapped = tr.changes.mapPos(pos, 1);
            check(
              inside(before, pos) === inside(after, mapped),
              `${id} at ${pos}: ${shown(before)} → ${shown(after)}`,
            );
          }
        },
        { testCases: 400 },
      ),
    20_000,
  );

  test(
    "next to punctuation, a selection is never refused",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(
            gs.sampledFrom(INLINE.filter((each) => each !== "code")),
          );
          const before = stateWith(tc, "ab.,!?");
          const { from, to } = before.selection.main;
          if (before.sliceDoc(from, to).trim() === "") return;
          // Four spaces open a code block: nothing is formatted there.
          if (/^ {4}/m.test(before.doc.toString())) return;
          check(
            constructTransaction(before, id) !== null,
            `${id}: ${shown(before)} refused`,
          );
        },
        { testCases: 400 },
      ),
    20_000,
  );
});
