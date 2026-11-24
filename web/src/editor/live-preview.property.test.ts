// @vitest-environment jsdom
// Live formatting's properties (phase 11b.2): what stays visible of a line
// is what the preview shows of it; nothing is hidden on a line the
// selection touches; no decoration ever edits the text.

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import { createDocumentEditor } from "./editor.js";
import { type LiveSpec, livePreview } from "./live-preview.js";
import { toggleTask } from "./live-widgets.js";
import { markdownSyntax } from "./markdown-syntax.js";

// Inline Markdown both parsers read, and the characters that make it
// ambiguous; images, remote (a link's text) and embedded (drawn, no text).
// Not here, kept as written by both: entities, HTML, footnotes; formulas
// have their own property (math-syntax).
const INLINE = [
  "a",
  "bc",
  "x_y",
  " ",
  "  ",
  "*",
  "**",
  "_",
  "__",
  "~",
  "~~",
  // Highlights (ADR-0044), a color's emoji, another emoji.
  "=",
  "==",
  "==🔴",
  "🟣",
  "⚫",
  "`",
  "``",
  "` a `",
  "`` `x` ``",
  "\\",
  "\\*",
  "[",
  "]",
  "(",
  ")",
  '"',
  "#",
  ".",
  "[t](https://u.org)",
  '[t](u "ti")',
  "[t](\nu)",
  "<https://y.org>",
  "![a](https://u.org/i.png)",
  "![b](data:image/png;base64,AAAA)",
  // Attached (ADR-0057 §8): drawn, no text, once its image is shown.
  "![c](attachment:AAECAwQFBgcICQoLDA0ODw)",
  "https://z.org",
  // Obsidian's [[…]] (phase 19, decision 7), and what makes it ambiguous.
  "[[",
  "]]",
  "|",
  "!",
  "[[#T]]",
  "[[#T|a]]",
  "[[#A#B]]",
  "[[#^b]]",
  "[[N]]",
  "[[N#T|*a*]]",
  "[[N|]]",
  "![[N]]",
];

// A code span, a formula or an image over a line break: a plugin keeps the
// break visible (analysis 11a.1), where the preview shows a space or draws
// them; not compared with the preview, but revealed and edited like the
// rest, never replaced across the break.
const MULTILINE = [
  ...INLINE,
  "`a\nb`",
  "$a\nb$",
  "$$a\nb$$",
  "![a\nb](data:image/png;base64,AAAA)",
  "![a\nb](attachment:AAECAwQFBgcICQoLDA0ODw)",
  "[[a\nb]]",
];

// Block starts the preview renders as the editor shows them, up to its
// numbers (an ordered list shows its own) and code (fences stay visible).
const BLOCK_STARTS = [
  "# ",
  "### ",
  "- ",
  "* ",
  "+ ",
  "> ",
  "> > ",
  "- [ ] ",
  "- [x] ",
  "> - ",
  "- > ",
  "- # ",
];

// A callout's header, or near one (phase 15): outside a quote, text in
// both parsers.
const HEADERS = [
  "[!note] ",
  "[!tip]- ",
  "[!Mon Type]+ ",
  "[!*a*] ",
  "[!a|m] ",
  "[!note]x ",
  "[!] ",
  "[!t](https://u.org) ",
];

const LINE_STARTS = [
  "",
  "",
  ...BLOCK_STARTS,
  "1. ",
  "    ",
  "```",
  "---",
  "> [!note]- ",
  "> [!tip] ",
  ">  [!info] ",
];

/** Known divergence, rare in prose (ADR-0044): an emoji, or any character
 * past U+FFFF, right against a `*`, `_` or `~` run. markdown-it reads it
 * whole, a symbol, so punctuation; `@lezer/markdown` reads half of it,
 * neither, and pairs the run otherwise. The highlights' own parser reads
 * it as markdown-it does. */
// Known divergence too (ADR-0044 point 6): a run of `=` opening two
// highlights, one inside the other (`====a== b==`, `====a====`), opens one
// in the editor. Drawn from two `==` side by side: left out.
const SYMBOL_BY_DELIMITER =
  /[\u{10000}-\u{10FFFF}][*_~]|[*_~][\u{10000}-\u{10FFFF}]/u;
const NESTED_HIGHLIGHTS = /={4,}/;

function specsOf(
  text: string,
  selection: { from: number; to: number }[],
): {
  specs: LiveSpec[];
  state: EditorState;
  referenceLink: boolean;
  codeAcrossLines: boolean;
  unbalancedAddress: boolean;
} {
  const state = EditorState.create({
    doc: text,
    extensions: [markdownSyntax()],
  });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  const specs = livePreview(tree, state.doc, selection, [
    { from: 0, to: text.length },
  ]);
  let referenceLink = false;
  let codeAcrossLines = false;
  let unbalancedAddress = false;
  tree.iterate({
    enter: (node) => {
      if (node.name === "Link" && !node.node.getChild("URL"))
        referenceLink = true;
      if (
        node.name === "InlineCode" &&
        text.slice(node.from, node.to).includes("\n")
      )
        codeAcrossLines = true;
      if (node.name === "URL" && !balanced(text.slice(node.from, node.to)))
        unbalancedAddress = true;
    },
  });
  return { specs, state, referenceLink, codeAcrossLines, unbalancedAddress };
}

/** Whether an address's unescaped parentheses pair up, as CommonMark
 * requires (markdown-it does; @lezer/markdown takes `[t](u` whole). */
function balanced(address: string): boolean {
  let depth = 0;
  for (const found of address.matchAll(/\\.|[()]/g)) {
    if (found[0] === "(") depth++;
    else if (found[0] === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** The text as shown, a widget (dot, box, with its space) counting for no
 * text. */
function shown(text: string, specs: LiveSpec[]): string {
  let out = "";
  let at = 0;
  for (const spec of specs.filter(
    (s) => s.kind === "hide" || s.kind === "widget",
  )) {
    out += text.slice(at, Math.max(at, spec.from));
    at = Math.max(at, spec.to);
  }
  return out + text.slice(at);
}

/** What the preview shows of a paragraph's line. */
function previewText(line: string): string {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(line);
  // An attached image's text until the view draws it, as the editor does.
  for (const text of Array.from(div.querySelectorAll(".attached-image-text")))
    text.remove();
  return div.querySelector("p")?.textContent ?? "";
}

/** What the preview shows of a line, whatever its blocks; a task's box
 * and the space after it are its marker, drawn apart, as in the editor; a
 * callout's default title is not in the text, a widget in the editor. */
function previewAll(line: string): string {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(line);
  for (const title of Array.from(
    div.querySelectorAll(".md-callout-default-title, .attached-image-text"),
  ))
    title.remove();
  for (const box of Array.from(div.querySelectorAll("input"))) {
    const next = box.nextSibling;
    if (next?.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(" "))
      next.textContent = next.textContent.slice(1);
    box.remove();
  }
  return div.textContent ?? "";
}

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** One case of « a line that starts a block shows what the preview shows
 * of it », its draws from `tc`: the property's body, and a counter-example's
 * replay. */
function blockLineCase(tc: TC): void {
  const start = tc.draw(gs.sampledFrom(BLOCK_STARTS));
  // In a quote, a header opens a callout (phase 15), on the
  // quote's first line only: not after a blank `>` line.
  const word = tc.draw(gs.sampledFrom(["p ", "p ", ...HEADERS]));
  const blank = tc.draw(gs.sampledFrom(["", "", ">\n", "> >\n"]));
  const line =
    `${blank}${start}${word}${tc.draw(gs.arrays(gs.sampledFrom(INLINE), { maxSize: 8 })).join("")}`.trimEnd();
  // The known divergences of the inline property, for the same
  // reasons.
  tc.assume(!line.includes("\\`") && !line.includes("~~~"));
  tc.assume(!SYMBOL_BY_DELIMITER.test(line));
  tc.assume(!NESTED_HIGHLIGHTS.test(line));
  const { specs, referenceLink, codeAcrossLines, unbalancedAddress } = specsOf(
    line,
    [],
  );
  tc.assume(!codeAcrossLines && !referenceLink && !unbalancedAddress);
  // A dot or a box, and its space, are the item's marker, which
  // the preview draws apart from the text too.
  const editor = shown(line, specs).replace(/\n/g, "").trimEnd();
  const preview = previewAll(line).replace(/\n/g, "").trimEnd();
  if (editor !== preview) {
    throw new Error(
      `line=${JSON.stringify(line)}\neditor=${JSON.stringify(editor)}\npreview=${JSON.stringify(preview)}`,
    );
  }
}

/** A `tc` that gives back recorded draws, in order; `done` says whether all
 * were taken. */
function replay(draws: readonly unknown[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
    assume: (condition: boolean) => {
      if (!condition) throw new Error("a recorded case is rejected");
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("livePreview (properties)", () => {
  test(
    "what stays visible of a line is what the preview shows of it",
    () =>
      hegel.test(
        (tc) => {
          // A paragraph: it starts with a word or a callout's header, never
          // a block's mark; its trailing spaces are dropped by both parsers.
          const start = tc.draw(gs.sampledFrom(["p ", "p ", ...HEADERS]));
          const line =
            `${start}${tc.draw(gs.arrays(gs.sampledFrom(INLINE), { maxSize: 12 })).join("")}`.trimEnd();
          // Known divergences between the parsers, rare in prose: an
          // escaped backtick before a code span (the editor's parser pairs
          // the backticks otherwise), runs of three tildes or more
          // (markdown-it pairs them two by two).
          tc.assume(!line.includes("\\`") && !line.includes("~~~"));
          tc.assume(!SYMBOL_BY_DELIMITER.test(line));
          tc.assume(!NESTED_HIGHLIGHTS.test(line));
          const { specs, referenceLink, codeAcrossLines, unbalancedAddress } =
            specsOf(line, []);
          tc.assume(!codeAcrossLines);
          // Known divergence, rare: an address whose parentheses do not
          // pair up (`[](` then `[t](u "ti")`), a link for the editor's
          // parser only (phase 15, 15c).
          tc.assume(!unbalancedAddress);
          // Line breaks aside: a plugin may not hide one, even inside
          // markup (`[t](` then the address on the next line, analysis
          // 11a.1); a soft break is one on both sides.
          const editor = shown(line, specs).replace(/\n/g, "");
          const preview = previewText(line).replace(/\n/g, "");
          // Known divergence: without the document's reference
          // definitions, the editor's parser takes `[a]`, `[a][b]` for
          // links where markdown-it reads emphasis or a later link; the
          // two then pair the markers otherwise, and either may show what
          // the other hides (`[*]_*_`: the editor hides the `_`).
          tc.assume(!referenceLink);
          if (editor !== preview) {
            throw new Error(
              `line=${JSON.stringify(line)}\neditor=${JSON.stringify(editor)}\npreview=${JSON.stringify(preview)}`,
            );
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );

  test(
    "a line that starts a block shows what the preview shows of it",
    () => hegel.test(blockLineCase, { testCases: 400 }),
    60_000,
  );

  // Found on 2026-10-31 (phase 22d, without relation to it: phase 22
  // touches only the server), kept here rather than only in web/.hegel:
  // a heading whose text opens a bracket before a wikilink, then an
  // escaped bracket and a link. The editor's parser read one link, of
  // text `[[#T]]\[t`, and hid its address (« p T[t »); markdown-it showed
  // « p [T[t](https://u.org) »: a link never holds another, `[[…]]`
  // included. Corrected the same day (wikilink-syntax.ts, `unopenLinks`).
  test("a counter-example kept: a bracket, a wikilink, an escaped bracket, a link", () => {
    const { tc, done } = replay([
      "# ",
      "p ",
      "",
      ["[", "[[#T]]", "\\", "[t](https://u.org)"],
    ]);
    blockLineCase(tc);
    if (!done()) throw new Error("draws left over");
  });

  test(
    "nothing is hidden on a line the selection touches, a hidden range stays in its line",
    () =>
      hegel.test(
        (tc) => {
          const lines = tc.draw(
            gs.arrays(
              gs.tuples(
                gs.sampledFrom(LINE_STARTS),
                gs.arrays(gs.sampledFrom(MULTILINE), { maxSize: 8 }),
              ),
              { minSize: 1, maxSize: 6 },
            ),
          );
          const text = lines
            .map(([start, words]) => `${start}${words.join("")}`)
            .join("\n");
          const ranges = tc.draw(
            gs.arrays(
              gs.tuples(
                gs.integers({ minValue: 0, maxValue: text.length }),
                gs.integers({ minValue: 0, maxValue: text.length }),
              ),
              { maxSize: 2 },
            ),
          );
          const selection = ranges.map(([a, b]) => ({
            from: Math.min(a, b),
            to: Math.max(a, b),
          }));
          const { specs, state } = specsOf(text, selection);
          const touched = new Set<number>();
          for (const { from, to } of selection) {
            const last = state.doc.lineAt(to).number;
            for (let n = state.doc.lineAt(from).number; n <= last; n++)
              touched.add(n);
          }
          for (const spec of specs.filter((s) => s.kind === "line")) {
            if (state.doc.lineAt(spec.from).from !== spec.from) {
              throw new Error(
                `line class off a line's start: ${JSON.stringify(spec)}`,
              );
            }
          }
          for (const spec of specs.filter(
            (s) => s.kind === "hide" || s.kind === "widget",
          )) {
            const line = state.doc.lineAt(spec.from);
            if (spec.to > line.to) {
              throw new Error(`hidden across lines: ${JSON.stringify(spec)}`);
            }
            if (touched.has(line.number)) {
              throw new Error(
                `hidden on touched line ${line.number}: text=${JSON.stringify(text)} selection=${JSON.stringify(selection)}`,
              );
            }
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );

  test(
    "no decoration edits the text: moves, focus, typing and ticks leave the text they made",
    () =>
      hegel.test(
        (tc) => {
          // A document to start from, its blocks included (tasks to tick).
          let expected = tc
            .draw(
              gs.arrays(
                gs.tuples(
                  gs.sampledFrom(LINE_STARTS),
                  gs.arrays(gs.sampledFrom(MULTILINE), { maxSize: 4 }),
                ),
                { maxSize: 4 },
              ),
            )
            .map(([start, words]) => `${start}${words.join("")}`)
            .join("\n");
          const doc = new LoroDoc();
          doc.getText("content").insert(0, expected);
          doc.commit();
          const parent = document.createElement("div");
          document.body.append(parent);
          const { view } = createDocumentEditor(parent, doc, {
            livePreview: true,
          });
          try {
            const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
            for (let i = 0; i < steps; i++) {
              const drawn = tc.draw(
                gs.integers({ minValue: 0, maxValue: expected.length }),
              );
              // Between two characters, never inside an emoji's surrogate
              // pair: the editor's caret never is, and Loro counts whole
              // characters (an insertion there would be lost).
              const at = /[\uDC00-\uDFFF]/.test(expected.charAt(drawn))
                ? drawn - 1
                : drawn;
              switch (
                tc.draw(gs.sampledFrom(["type", "move", "focus", "tick"]))
              ) {
                case "type": {
                  const insert = tc.draw(
                    gs.sampledFrom([...MULTILINE, "\n", ...LINE_STARTS]),
                  );
                  view.dispatch({
                    changes: { from: at, insert },
                    selection: { anchor: at + insert.length },
                  });
                  expected =
                    expected.slice(0, at) + insert + expected.slice(at);
                  break;
                }
                case "move":
                  view.dispatch({ selection: { anchor: at } });
                  break;
                case "focus":
                  if (view.hasFocus) view.contentDOM.blur();
                  else view.focus();
                  break;
                case "tick": {
                  // On a marker when there is one (a random position rarely
                  // is), else anywhere. Only a marker changes, and only its
                  // middle character.
                  const markers = Array.from(
                    expected.matchAll(/\[[ xX]\]/g),
                    (match) => match.index,
                  );
                  const where =
                    markers.length > 0 && tc.draw(gs.booleans())
                      ? (markers[
                          tc.draw(
                            gs.integers({
                              minValue: 0,
                              maxValue: markers.length - 1,
                            }),
                          )
                        ] as number)
                      : at;
                  const marker = expected.slice(where, where + 3);
                  const ticked = toggleTask(view, where);
                  if (ticked !== /^\[[ xX]\]$/.test(marker)) {
                    throw new Error(
                      `tick at ${where} of ${JSON.stringify(expected)}: ${ticked}`,
                    );
                  }
                  if (ticked) {
                    expected = `${expected.slice(0, where + 1)}${marker[1] === " " ? "x" : " "}${expected.slice(where + 2)}`;
                  }
                  break;
                }
              }
              const editor = view.state.doc.toString();
              const loro = doc.getText("content").toString();
              if (editor !== expected || loro !== expected) {
                throw new Error(
                  `expected=${JSON.stringify(expected)} editor=${JSON.stringify(editor)} loro=${JSON.stringify(loro)}`,
                );
              }
            }
          } finally {
            view.destroy();
            parent.remove();
          }
        },
        { testCases: 200 },
      ),
    60_000,
  );
});
