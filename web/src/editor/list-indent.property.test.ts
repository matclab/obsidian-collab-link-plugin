// @vitest-environment jsdom
// Tab and Shift+Tab in a list (ADR-0054): the item goes under the one
// before it, or beside the one it was in, for the editor's parser and the
// preview's alike; down then up gives the text back.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { SyntaxNode } from "@lezer/common";
import { describe, expect, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { indentChange } from "./list-indent.js";
import { markdownSyntax } from "./markdown-syntax.js";

type Item = { depth: number; marker: string; blankBefore: boolean };

/** Each item's word (`w3`), and the word of the item it is in, if any. */
type Nesting = Record<string, string | null>;

const ownWord = (text: string) => /w\d+/.exec(text)?.[0] ?? "?";

function stateOf(text: string, at: number): EditorState {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(at),
    extensions: markdownSyntax(),
  });
}

/** The nesting the editor's parser reads. */
function editorNesting(text: string): Nesting {
  const state = stateOf(text, 0);
  const tree = ensureSyntaxTree(state, text.length, 5000);
  const nesting: Nesting = {};
  const wordOf = (item: SyntaxNode) =>
    ownWord(state.doc.lineAt(item.from).text);
  tree?.iterate({
    enter(node) {
      if (node.name !== "ListItem") return;
      let parent = node.node.parent;
      while (parent && parent.name !== "ListItem") parent = parent.parent;
      nesting[wordOf(node.node)] = parent ? wordOf(parent) : null;
    },
  });
  return nesting;
}

/** The nesting the preview draws; a word in no item is « text ». */
function previewNesting(text: string): Nesting {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(text);
  const wordOf = (item: Element) => {
    const own = item.cloneNode(true) as Element;
    for (const list of Array.from(own.querySelectorAll("ul, ol"))) {
      list.remove();
    }
    return ownWord(own.textContent ?? "");
  };
  const nesting: Nesting = {};
  for (const item of Array.from(root.querySelectorAll("li"))) {
    const parent = item.parentElement?.closest("li");
    nesting[wordOf(item)] = parent ? wordOf(parent) : null;
  }
  return nesting;
}

const items = gs
  .arrays(
    gs.tuples(
      gs.integers({ minValue: 0, maxValue: 3 }),
      gs.sampledFrom(["-", "*", "1.", "2.", "1)"]),
      gs.sampledFrom([false, false, false, true]),
    ),
    { minSize: 2, maxSize: 6 },
  )
  .map((drawn) => {
    // Each item at most one level under the one before.
    let depth = -1;
    return drawn.map(([wanted, marker, blankBefore]): Item => {
      depth = Math.min(wanted, depth + 1);
      return { depth, marker, blankBefore };
    });
  });

/** The text, and where each item's line ends. */
function write(list: readonly Item[], quote: string) {
  let text = "";
  const ends: number[] = [];
  list.forEach((item, i) => {
    if (i > 0) text += item.blankBefore ? `\n${quote.trimEnd()}\n` : "\n";
    text += `${quote}${"\t".repeat(item.depth)}${item.marker} w${i}`;
    ends.push(text.length);
  });
  return { text, ends };
}

/** The text after Tab (1) or Shift+Tab (-1), and where the caret went;
 * null when nothing changes. */
function press(text: string, at: number, by: 1 | -1) {
  const state = stateOf(text, at);
  const spec = indentChange(state, by);
  if (!spec) return null;
  const tr = state.update(spec);
  return { text: tr.state.doc.toString(), at: tr.changes.mapPos(at, 1) };
}

/** A divergence of the two parsers, admitted (ADR-0054, Conséquences): a
 * numbered item other than 1 right under a bulleted item of its column.
 * It can't start a list that would interrupt that item's paragraph: the
 * editor's parser reads it as that paragraph's text, as CommonMark does;
 * markdown-it, a list. */
function numberUnderBullet(text: string): boolean {
  const lines = text.split("\n").map((line) => line.replace(/^> ?/, ""));
  return lines.some((line, i) => {
    const numbered = /^([ \t]*)(\d+)[.)] /.exec(line);
    const bullet = /^([ \t]*)[-*+] /.exec(lines[i - 1] ?? "");
    return numbered?.[2] !== "1" && numbered?.[1] === bullet?.[1];
  });
}

/** The item `word` is in, the two parsers reading `text` alike. */
function parentIn(text: string, word: string): string | null | undefined {
  const editor = editorNesting(text);
  if (!numberUnderBullet(text)) expect(editor).toEqual(previewNesting(text));
  return editor[word];
}

/** The blank before the mark of item `k`'s line. */
const blankOf = (text: string, k: number) =>
  new RegExp(`^(?:> )?([ \\t]*)\\S+ w${k}$`, "m").exec(text)?.[1];

/** The property's body: `tc`, Hegel's, or a counter-example's replay. */
type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];
const indentScenario = (tc: TC): void => {
  const list = tc.draw(items);
  const quote = tc.draw(gs.sampledFrom(["", "", "> "]));
  const { text, ends } = write(list, quote);
  const before = editorNesting(text);
  // Only lists the two parsers read alike to start with.
  tc.assume(JSON.stringify(before) === JSON.stringify(previewNesting(text)));
  const k = tc.draw(gs.integers({ minValue: 0, maxValue: list.length - 1 }));
  const word = `w${k}`;
  tc.assume(word in before);
  const at = ends[k] as number;

  const down = press(text, at, 1);
  if (down !== null) {
    // Under the item that was just before it, at its level.
    const siblings = Object.keys(before).filter(
      (w) => before[w] === before[word] && Number(w.slice(1)) < k,
    );
    const previous = siblings.at(-1);
    expect(parentIn(down.text, word)).toBe(previous);
    // Up again gives the text back, when it was at its sibling's
    // level and kept its number.
    const level =
      blankOf(text, k) === blankOf(text, Number(previous?.slice(1)));
    const marker = list[k]?.marker ?? "";
    const renumbered = /^\d/.test(marker) && !marker.startsWith("1");
    if (level && !renumbered) {
      expect(press(down.text, down.at, -1)?.text).toBe(text);
    }
  }

  const up = press(text, at, -1);
  if (up !== null) {
    const formerParent = before[word] as string;
    expect(parentIn(up.text, word)).toBe(before[formerParent] ?? null);
  } else {
    expect(before[word]).toBeNull();
  }
};

/** A counter-example's draws, given again in order. */
function replay(draws: readonly unknown[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
    assume: (condition: boolean) => {
      if (!condition) throw new Error("a replay assumed false");
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("Tab and Shift+Tab in a list (property)", () => {
  test(
    "one level down, under the item before; up, beside its parent: both parsers agree, and down then up gives the text back",
    () => hegel.test(indentScenario, { testCases: 400 }),
    120_000,
  );

  // Found on 2026-11-12 (red at 7891bad): `1. w0` / `\t1) w1` /
  // `\t2. w2`, Shift+Tab on w1. w2, in a list of its own beside w1's,
  // became w1's child, numbered 2: CommonMark reads it as w1's text, the
  // editor's parser as a list (decision 9 of ADR-0054 not applied).
  test("a counter-example kept: up, the item after it in another list starts at 1", () => {
    const { tc, done } = replay([
      [
        { depth: 0, marker: "1.", blankBefore: false },
        { depth: 1, marker: "1)", blankBefore: false },
        { depth: 1, marker: "2.", blankBefore: false },
      ],
      "",
      1,
    ]);
    indentScenario(tc);
    expect(done()).toBe(true);
  });
});
