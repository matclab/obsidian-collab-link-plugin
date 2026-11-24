import { undo } from "@codemirror/commands";
import { EditorSelection, StateEffect } from "@codemirror/state";
// @vitest-environment jsdom
// The menu of a link to a heading against another's edits (phase 20,
// decision 9; analysis 20.0, interleavings 1 to 7), each order a choice of
// the test: two of the page's editors on their Loro docs, each with its
// outline as the view wires it, each one's updates held until Hegel
// delivers them; B also writes, renames and removes headings. At every
// step, on A: open, the menu is exactly `](#` or `[[#` and what A typed
// since its # (a model kept by the test); a choice replaces only that,
// by the active heading, and closes the link once. Both texts converge
// once everything is delivered.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { followEditor } from "../outline/follow-editor.js";
import { OutlineIndex } from "../outline/outline-index.js";
import {
  anchorHeadings,
  anchorState,
  chooseAnchor,
  closeAnchor,
  moveAnchor,
} from "./anchor-menu.js";
import { createDocumentEditor } from "./editor.js";
import { withoutLayout } from "./test-support/no-layout.js";

const destroyed = withoutLayout();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A peer: its editor and outline, its doc, its updates not yet delivered. */
function peer(id: bigint) {
  const doc = new LoroDoc();
  // Fixed: Loro orders concurrent insertions by peer, and a drawn bound
  // would differ from one run to the next.
  doc.setPeerId(id);
  const editor = createDocumentEditor(document.createElement("div"), doc);
  destroyed(editor.view);
  const outline = new OutlineIndex(editor.view.state.doc);
  followEditor(editor.view, outline);
  editor.view.dispatch({
    effects: StateEffect.appendConfig.of(
      anchorHeadings.of(() => outline.current()),
    ),
  });
  const held: Uint8Array[] = [];
  doc.subscribeLocalUpdates((update) => {
    held.push(update);
  });
  return { doc, editor, held };
}

const OPENING = { link: "](", wikilink: "[[" } as const;
const CLOSING = { link: ")", wikilink: "]]" } as const;

const STEPS = [
  "a types",
  "a types",
  "a opens a link",
  "a deletes",
  "a moves",
  "a escape",
  "a down",
  "a chooses",
  "a undoes",
  "b edits",
  "b edits",
  "deliver to a",
  "deliver to b",
  "b types in a's #…",
  "b removes a's opening",
] as const;

describe("the menu of a link to a heading and another's edits (property)", () => {
  test(
    "open, exactly what the user typed since its #; a choice replaces only that",
    () =>
      hegel.test(
        (tc) => {
          const a = peer(1n);
          const b = peer(2n);
          const base = tc.draw(
            gs.sampledFrom([
              "# Mon titre\n\n## Notes\n\n",
              "# Un\n\n## Notes\n\n# Deux\n\n## Notes\n\nab ",
              "texte\n\n## Relevé\n\nx",
            ]),
          );
          a.editor.view.dispatch({ changes: { from: 0, insert: base } });
          b.doc.import(a.doc.export({ mode: "update" }));
          a.held.length = 0;
          // What A typed since the # that opened the menu, as A typed it.
          let typed: string | null = null;
          const log: string[] = [];
          const view = a.editor.view;
          const typeAt = (text: string) => {
            for (const char of text) {
              const caret = view.state.selection.main.head;
              view.dispatch({
                changes: { from: caret, insert: char },
                selection: { anchor: caret + 1 },
                userEvent: "input.type",
              });
            }
          };
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
          for (let step = 0; step < steps; step++) {
            const action = tc.draw(gs.sampledFrom([...STEPS]));
            log.push(action);
            const head = view.state.selection.main.head;
            const wasOpen = anchorState(view.state) !== null;
            if (action === "a types") {
              const char = tc.draw(
                gs.sampledFrom(["n", "o", "t", "e", " ", ")", "#", "/"]),
              );
              typeAt(char);
              log.push(JSON.stringify(char));
              if (anchorState(view.state)) {
                typed = wasOpen && typed !== null ? typed + char : "#";
              }
            } else if (action === "a opens a link") {
              const opening = tc.draw(gs.sampledFrom(["[t](#", "[[#"]));
              typeAt(opening);
              log.push(JSON.stringify(opening));
              if (anchorState(view.state)) typed = "#";
            } else if (action === "a deletes" && head > 0) {
              view.dispatch({
                changes: { from: head - 1, to: head },
                userEvent: "delete.backward",
              });
              if (typed !== null) typed = typed.slice(0, -1);
            } else if (action === "a moves") {
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: view.state.doc.length }),
              );
              view.dispatch({
                selection: EditorSelection.cursor(at),
                userEvent: "select",
              });
            } else if (action === "a escape") {
              view.dispatch(closeAnchor(view.state));
            } else if (action === "a down") {
              view.dispatch(moveAnchor(view.state, 1));
            } else if (action === "a chooses") {
              const open = anchorState(view.state);
              const spec = chooseAnchor(view.state);
              if (open && spec) {
                const chosen = open.matches[open.active];
                const text = view.state.doc.toString();
                const end = open.from + 1 + open.query.length;
                const closing = CLOSING[open.form];
                const closed = text.startsWith(closing, end);
                view.dispatch(spec);
                const after = view.state.doc.toString();
                const expected =
                  text.slice(0, open.from + 1) +
                  (chosen?.fragment ?? "?") +
                  (closed ? "" : closing) +
                  text.slice(end);
                check(
                  after === expected,
                  `chose ${JSON.stringify(after)}, not ${JSON.stringify(expected)} (${log})`,
                );
                check(
                  view.state.selection.main.head ===
                    open.from +
                      1 +
                      (chosen?.fragment.length ?? 0) +
                      closing.length,
                  `the caret not after the link (${log})`,
                );
              }
            } else if (action === "a undoes") {
              undo(view);
            } else if (action === "b edits") {
              const length = b.editor.view.state.doc.length;
              const from = tc.draw(
                gs.integers({ minValue: 0, maxValue: length }),
              );
              const to = tc.draw(
                gs.integers({ minValue: from, maxValue: length }),
              );
              const insert = tc.draw(
                gs.sampledFrom(["", "z", "\n# Neuf\n", "## ", "](", "#"]),
              );
              b.editor.view.dispatch({
                changes: { from, to, insert },
                userEvent: "input.type",
              });
              log.push(`b ${from}…${to} ${JSON.stringify(insert)}`);
            } else if (action === "b types in a's #…") {
              // One composed gesture (AGENTS.md §1.6), an order the steps
              // alone almost never draw: A opens a link and types "no";
              // it reaches B, who puts "te" right after the #; it comes
              // back to A, whose menu must not take B's text for its own.
              typeAt("[t](#no");
              typed = anchorState(view.state) ? "#no" : null;
              a.doc.importBatch(b.held.splice(0));
              b.doc.importBatch(a.held.splice(0));
              const open = anchorState(view.state);
              if (open) {
                b.editor.view.dispatch({
                  changes: { from: open.from + 1, insert: "te" },
                  userEvent: "input.type",
                });
                a.doc.importBatch(b.held.splice(0));
                log.push(`b puts te at ${open.from + 1}`);
              }
            } else if (action === "b removes a's opening") {
              // Another composed gesture: A opens a link; it reaches B,
              // who deletes its `](` or `[[`; it comes back to A, whose
              // menu is no longer in a link.
              typeAt(tc.draw(gs.sampledFrom(["[t](#", "[[#"])));
              typed = anchorState(view.state) ? "#" : null;
              a.doc.importBatch(b.held.splice(0));
              b.doc.importBatch(a.held.splice(0));
              const open = anchorState(view.state);
              if (open) {
                b.editor.view.dispatch({
                  changes: { from: open.from - 2, to: open.from },
                  userEvent: "delete.backward",
                });
                a.doc.importBatch(b.held.splice(0));
                log.push(`b deletes ${open.from - 2}…${open.from}`);
              }
            } else if (action === "deliver to a" && b.held.length > 0) {
              a.doc.importBatch(b.held.splice(0));
            } else if (action === "deliver to b" && a.held.length > 0) {
              b.doc.importBatch(a.held.splice(0));
            }
            const open = anchorState(view.state);
            if (!open) {
              typed = null;
              continue;
            }
            const caret = view.state.selection.main.head;
            const shown = view.state.sliceDoc(open.from, caret);
            check(
              shown === `#${open.query}`,
              `open on ${JSON.stringify(shown)}, query ${JSON.stringify(open.query)} (${log})`,
            );
            check(
              view.state.sliceDoc(open.from - 2, open.from) ===
                OPENING[open.form],
              `open without its ${OPENING[open.form]} (${log})`,
            );
            check(
              typed === null || shown === typed,
              `open on ${JSON.stringify(shown)}, typed ${JSON.stringify(typed)} (${log})`,
            );
          }
          a.doc.importBatch(b.held.splice(0));
          b.doc.importBatch(a.held.splice(0));
          check(
            a.editor.view.state.doc.toString() ===
              b.editor.view.state.doc.toString(),
            `not converged (${log})`,
          );
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
