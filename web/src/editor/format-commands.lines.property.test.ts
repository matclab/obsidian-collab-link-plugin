import { undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
// @vitest-environment jsdom
// The line and block constructions' properties (phase 20, WA1 to WA3),
// with the preview as the oracle: after a toggle, the preview's markdown-it
// reads each line touched in the form asked, or no more in it; after an
// insertion, one block more, the others' forms unchanged.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { renderMarkdown } from "../render/index.js";
import {
  type BlockConstruct,
  CONSTRUCTS,
  type ConstructId,
} from "./constructs.js";
import { createDocumentEditor } from "./editor.js";
import { constructActive, constructTransaction } from "./format-commands.js";
import { markdownSyntax } from "./markdown-syntax.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const LINES: ConstructId[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "taskList",
  "quote",
];

const PREFIXES = [
  "",
  "# ",
  "## ",
  "- ",
  "* ",
  "1. ",
  "2) ",
  "- [ ] ",
  "- [x] ",
  "> ",
  "> - ",
  "> > ",
  "  - ",
  "- # ",
];

/** Lines of a word each (`w0`, `w1`…: found again in the preview), a
 * drawn block markup before it — often the line before's: a list, a
 * quote —, some blank, some a code fence. */
function drawLines(tc: hegel.TestCase): string {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const lines: string[] = [];
  let prefix = "";
  for (let i = 0; i < count; i++) {
    const kind = tc.draw(
      gs.sampledFrom(["text", "text", "text", "blank", "fence"]),
    );
    if (kind === "blank") lines.push("");
    else if (kind === "fence") lines.push("```");
    else {
      if (!tc.draw(gs.booleans())) prefix = tc.draw(gs.sampledFrom(PREFIXES));
      lines.push(`${prefix}w${i}`);
    }
  }
  return lines.join("\n");
}

/** A selection from a line to another, at drawn places in them. */
function drawSelection(tc: hegel.TestCase, text: string): EditorSelection {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  const ends = [...starts.slice(1).map((start) => start - 1), text.length];
  const first = tc.draw(
    gs.integers({ minValue: 0, maxValue: starts.length - 1 }),
  );
  const last = tc.draw(
    gs.integers({ minValue: first, maxValue: starts.length - 1 }),
  );
  const anchor = tc.draw(
    gs.integers({ minValue: starts[first] ?? 0, maxValue: ends[first] ?? 0 }),
  );
  const head = tc.draw(
    gs.integers({
      minValue: Math.max(anchor, starts[last] ?? 0),
      maxValue: ends[last] ?? 0,
    }),
  );
  return tc.draw(gs.booleans())
    ? EditorSelection.single(anchor, head)
    : EditorSelection.single(head, anchor);
}

/** The form the preview gives to the line holding `word`. */
function formIn(html: string, word: string): Record<string, unknown> | null {
  const root = document.createElement("div");
  root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!new RegExp(`\\b${word}\\b`).test(node.textContent ?? "")) continue;
    const element = node.parentElement;
    if (!element || element.closest("pre, code")) return null;
    const item = element.closest("li");
    return {
      heading: Number(
        element.closest("h1, h2, h3, h4, h5, h6")?.tagName.slice(1) ?? 0,
      ),
      bulletList:
        item?.parentElement?.tagName === "UL" &&
        !item.classList.contains("task-list-item"),
      orderedList: item?.parentElement?.tagName === "OL",
      taskList: item?.classList.contains("task-list-item") ?? false,
      quotes: ancestors(element, "BLOCKQUOTE"),
    };
  }
  return null;
}

function ancestors(element: Element, tag: string): number {
  let count = 0;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.tagName === tag) count++;
  }
  return count;
}

function has(form: Record<string, unknown>, id: ConstructId): boolean {
  if (id === "paragraph") return form.heading === 0;
  if (id.startsWith("heading")) return form.heading === Number(id.slice(7));
  return form[id] === true;
}

describe("line constructs (property)", () => {
  test(
    "each line touched is read in the form asked, or no more in it; the others unchanged",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(gs.sampledFrom(LINES));
          const text = drawLines(tc);
          const before = EditorState.create({
            doc: text,
            selection: drawSelection(tc, text),
            extensions: [markdownSyntax()],
          });
          const spec = constructTransaction(before, id);
          if (!spec) return;
          const off = constructActive(before, id);
          const after = before.update(spec).state;
          const shown = `${id} ${off ? "off" : "on"}: ${JSON.stringify(text)} → ${JSON.stringify(after.doc.toString())}`;
          const htmlBefore = renderMarkdown(before.doc.toString());
          const htmlAfter = renderMarkdown(after.doc.toString());
          const { from, to } = before.selection.main;
          const lines = text.split("\n");
          const changed = after.doc.toString().split("\n");
          let start = 0;
          let at = 0; // In `changed`.
          let first = true;
          for (const [index, line] of lines.entries()) {
            const end = start + line.length;
            const touched =
              start <= to &&
              from <= end &&
              !(from < to && start === to && start > from);
            start = end + 1;
            const word = /w\d/.exec(line)?.[0];
            if (!touched) {
              // On a blank line alone, a line between below it too
              // (`- \n\nb`: `b` not taken in the item).
              if (
                changed.length > lines.length &&
                changed[at] === "" &&
                line !== "" &&
                (lines[index - 1] ?? "x").trim() === ""
              )
                at++;
              check(changed[at] === line, `line ${index} changed: ${shown}`);
              at++;
              continue;
            }
            // Out of a list or a quote, a line between, before the first
            // line touched only (`- a\n\nb`).
            if (
              first &&
              changed.length > lines.length &&
              /^(?:> ?)*$/.test(changed[at] ?? "x")
            )
              at++;
            first = false;
            at++;
            if (!word) continue;
            const was = formIn(htmlBefore, word);
            const now = formIn(htmlAfter, word);
            if (!was || !now) continue; // In a code block: left as it was.
            if (id === "quote") {
              const quotes = now.quotes as number;
              check(
                off ? quotes === (was.quotes as number) - 1 : quotes >= 1,
                `${word}: ${shown}`,
              );
            } else {
              check(has(now, id) !== off, `${word}: ${shown}`);
            }
          }
          check(at === changed.length, `lines: ${shown}`);
        },
        { testCases: 400 },
      ),
    20_000,
  );
});

describe("line constructs on a blank line (property)", () => {
  test(
    "what is typed after is read in the form asked; the other lines' forms unchanged",
    () =>
      hegel.test(
        (tc) => {
          const id = tc.draw(
            gs.sampledFrom(LINES.filter((each) => each !== "paragraph")),
          );
          const lines = drawLines(tc).split("\n");
          const blank = tc.draw(
            gs.integers({ minValue: 0, maxValue: lines.length }),
          );
          lines.splice(blank, 0, "");
          const text = lines.join("\n");
          const caret = lines.slice(0, blank).join("\n").length + (blank && 1);
          const before = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(caret),
            extensions: [markdownSyntax()],
          });
          const spec = constructTransaction(before, id);
          // Refused only where what is typed is code, for the preview.
          const code =
            formIn(
              renderMarkdown(`${text.slice(0, caret)}w9${text.slice(caret)}`),
              "w9",
            ) === null;
          check(
            (spec === null) === code,
            `${id} ${spec ? "applied" : "refused"}: ${JSON.stringify(text)}`,
          );
          if (!spec) return;
          const after = before.update(spec).state;
          const at = after.selection.main;
          const typed = after.update({
            changes: { from: at.from, insert: "w9" },
          }).state;
          const shown = `${id}: ${JSON.stringify(text)} → ${JSON.stringify(typed.doc.toString())}`;
          check(at.empty, `a caret: ${shown}`);
          const now = formIn(renderMarkdown(typed.doc.toString()), "w9");
          check(
            now !== null &&
              (id === "quote" ? (now.quotes as number) >= 1 : has(now, id)),
            `w9: ${shown}`,
          );
          // Neither the command nor what is typed after changes another
          // line's form (`- w9\nw0` would take `w0` in the item).
          const htmlBefore = renderMarkdown(text);
          for (const html of [after, typed].map((each) =>
            renderMarkdown(each.doc.toString()),
          )) {
            for (const word of text.match(/w\d/g) ?? []) {
              check(
                JSON.stringify(formIn(htmlBefore, word)) ===
                  JSON.stringify(formIn(html, word)),
                `${word}: ${shown}`,
              );
            }
          }
        },
        { testCases: 400 },
      ),
    20_000,
  );
});

const BLOCKS = CONSTRUCTS.filter(
  (each): each is BlockConstruct => each.kind === "block",
);

/** What the preview draws a block of the catalogue as. */
const DRAWN: Record<BlockConstruct["id"], string> = {
  callout: ".md-callout",
  table: "table",
  codeBlock: "pre:not(.mermaid pre)",
  mathBlock: ".math-display",
  diagram: ".mermaid",
  rule: "hr",
};

function count(html: string, selector: string): number {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root.querySelectorAll(selector).length;
}

describe("block constructs (property)", () => {
  test(
    "one block more, the lines' forms and text unchanged",
    () =>
      hegel.test(
        (tc) => {
          const it = tc.draw(gs.sampledFrom(BLOCKS));
          const text = drawLines(tc);
          const caret = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length }),
          );
          const before = EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(caret),
            extensions: [markdownSyntax()],
          });
          const spec = constructTransaction(before, it.id);
          // A fence left open takes the text to its end: nothing goes after.
          const open = (text.match(/^```/gm) ?? []).length % 2 === 1;
          check(
            spec !== null || open,
            `${it.id} refused: ${JSON.stringify(text)}`,
          );
          if (!spec) return;
          const after = before.update(spec).state;
          const result = after.doc.toString();
          const shown = `${it.id}: ${JSON.stringify(text)} → ${JSON.stringify(result)}`;
          const htmlBefore = renderMarkdown(text);
          const htmlAfter = renderMarkdown(result);
          const selector = DRAWN[it.id];
          check(
            count(htmlAfter, selector) === count(htmlBefore, selector) + 1,
            `not one ${selector} more: ${shown}`,
          );
          for (const word of text.match(/w\d/g) ?? []) {
            check(
              JSON.stringify(formIn(htmlAfter, word)) ===
                JSON.stringify(formIn(htmlBefore, word)),
              `${word}'s form: ${shown}`,
            );
          }
          const at = after.selection.main.from - it.selected.from;
          check(
            result.slice(at, at + it.template.length) === it.template,
            `template: ${shown}`,
          );
          const without =
            result.slice(0, at) + result.slice(at + it.template.length);
          check(
            without.replace(/\n+/g, "\n") === text.replace(/\n+/g, "\n") ||
              without.replace(/\n+/g, "\n").replace(/\n$/, "") ===
                text.replace(/\n+/g, "\n").replace(/\n$/, ""),
            `text: ${shown}`,
          );
          check(
            after.selection.main.to === at + it.selected.to,
            `selection: ${shown}`,
          );
        },
        { testCases: 400 },
      ),
    20_000,
  );
});

describe("every construct in the page's editor (property)", () => {
  test(
    "one transaction, in Loro whole, taken back by one undo (WA1)",
    () =>
      hegel.test(
        (tc) => {
          const it = tc.draw(gs.sampledFrom([...CONSTRUCTS]));
          const text = drawLines(tc);
          const anchor = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length }),
          );
          const head = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length }),
          );
          const doc = new LoroDoc();
          const editor = createDocumentEditor(
            document.createElement("div"),
            doc,
          );
          editor.view.dispatch({ changes: { from: 0, insert: text } });
          editor.view.dispatch({
            selection: EditorSelection.single(anchor, head),
          });
          const spec = constructTransaction(editor.view.state, it.id);
          if (!spec?.changes) return;
          let commits = 0;
          const unsubscribe = doc.subscribeLocalUpdates(() => commits++);
          editor.view.dispatch(spec);
          unsubscribe();
          const loro = doc.getText("content").toString();
          check(
            loro === editor.view.state.doc.toString(),
            `${it.id}: Loro ${JSON.stringify(loro)}`,
          );
          check(commits === 1, `${it.id}: ${commits} commits`);
          check(undo(editor.view), `${it.id}: nothing to undo`);
          check(
            editor.view.state.doc.toString() === text,
            `${it.id}: undo ${JSON.stringify(editor.view.state.doc.toString())}`,
          );
          check(
            doc.getText("content").toString() === text,
            `${it.id}: Loro after undo`,
          );
          editor.destroy();
        },
        { testCases: 400 },
      ),
    20_000,
  );
});
