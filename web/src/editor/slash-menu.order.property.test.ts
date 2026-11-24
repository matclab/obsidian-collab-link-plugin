import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
// @vitest-environment jsdom
// The / menu against another's edits (phase 20c.2, analysis 20.0,
// interleavings 1 to 7), each order a choice of the test: two of the
// page's editors on their Loro docs, each one's updates held until Hegel
// delivers them. At every step, on A: open, the menu is exactly what A
// typed since its / (a model kept by the test); a choice replaces only
// that. And both texts converge once everything is delivered.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { createDocumentEditor } from "./editor.js";
import {
  chooseSlash,
  closeSlash,
  moveSlash,
  slashState,
} from "./slash-menu.js";
import { withoutLayout } from "./test-support/no-layout.js";

const destroyed = withoutLayout();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A peer: its editor, its doc, and its updates not yet delivered. */
function peer(text: string, id: bigint) {
  const doc = new LoroDoc();
  // Fixed: Loro orders concurrent insertions by peer, and a drawn bound
  // would differ from one run to the next.
  doc.setPeerId(id);
  const editor = createDocumentEditor(document.createElement("div"), doc);
  destroyed(editor.view);
  const held: Uint8Array[] = [];
  doc.subscribeLocalUpdates((update) => {
    held.push(update);
  });
  if (text) editor.view.dispatch({ changes: { from: 0, insert: text } });
  return { doc, editor, held };
}

const STEPS = [
  "a types",
  "a types",
  "a types /",
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
  "b types in a's /…",
] as const;

describe("found by the property", () => {
  // 2026-11-08, accepted by the user: « /a » typed at the head of
  // « # t », « Heading 1 » chosen (the second item for « a »): the
  // heading command toggles, as the toolbar's, and takes off the heading
  // the line already was.
  test("a heading chosen on a line that is one already toggles it off", () => {
    const { editor } = peer("# t\n\nab", 1n);
    const view = editor.view;
    view.dispatch({ selection: EditorSelection.cursor(0) });
    for (const char of "/a") {
      const head = view.state.selection.main.head;
      view.dispatch({
        changes: { from: head, insert: char },
        selection: { anchor: head + 1 },
        userEvent: "input.type",
      });
    }
    view.dispatch(moveSlash(view.state, 1));
    check(
      slashState(view.state)?.matches[1] === "heading1",
      "the second item is not Heading 1",
    );
    const spec = chooseSlash(view.state);
    if (spec) view.dispatch(spec);
    check(
      view.state.doc.toString() === "t\n\nab",
      `became ${JSON.stringify(view.state.doc.toString())}`,
    );
  });
});

describe("the / menu and another's edits (property)", () => {
  test(
    "open, exactly what the user typed since its /; a choice replaces only that",
    () =>
      hegel.test(
        (tc) => {
          const a = peer("", 1n);
          const b = peer("", 2n);
          const base = tc.draw(gs.sampledFrom(["", "x y", "# t\n\nab"]));
          a.editor.view.dispatch({ changes: { from: 0, insert: base } });
          b.doc.import(a.doc.export({ mode: "update" }));
          a.held.length = 0;
          // What A typed since the / that opened the menu, as A typed it.
          let typed: string | null = null;
          const log: string[] = [];
          const view = a.editor.view;
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
          for (let step = 0; step < steps; step++) {
            const action = tc.draw(gs.sampledFrom([...STEPS]));
            log.push(action);
            const head = view.state.selection.main.head;
            const wasOpen = slashState(view.state) !== null;
            if (action === "a types" || action === "a types /") {
              const char =
                action === "a types /"
                  ? "/"
                  : tc.draw(gs.sampledFrom(["t", "a", "b", "h", " "]));
              view.dispatch({
                changes: { from: head, insert: char },
                selection: { anchor: head + 1 },
                userEvent: "input.type",
              });
              log.push(JSON.stringify(char));
              if (slashState(view.state)) {
                typed = wasOpen && typed !== null ? typed + char : char;
              }
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
              view.dispatch(closeSlash(view.state));
            } else if (action === "a down") {
              view.dispatch(moveSlash(view.state, 1));
            } else if (action === "a chooses") {
              const open = slashState(view.state);
              const spec = chooseSlash(view.state);
              // A choice that can't apply there only closes the menu.
              if (open && spec?.changes) {
                const text = view.state.doc.toString();
                const end = open.from + 1 + open.query.length;
                view.dispatch(spec);
                // What was after the /… is still there, its lines in
                // order: a block goes after the top-level block of the
                // caret, maybe among them (decision 2).
                const after = view.state.doc.toString();
                // A heading's marker aside: choosing a heading on a heading
                // line toggles it off (accepted, 2026-11-08).
                const rest = text
                  .slice(end)
                  .split("\n")
                  .map((line) => line.trim().replace(/^#{1,6}[ \t]+/, ""))
                  .filter((line) => line !== "");
                let from = 0;
                const kept = rest.every((line) => {
                  const at = after.indexOf(line, from);
                  from = at + line.length;
                  return at >= 0;
                });
                check(
                  kept,
                  `after the /…, lost: ${JSON.stringify(text)} → ${JSON.stringify(after)} (${log})`,
                );
                check(
                  !after.includes(`/${open.query}`) ||
                    text.indexOf(`/${open.query}`) !==
                      text.lastIndexOf(`/${open.query}`),
                  `the /… still there: ${JSON.stringify(after)} (${log})`,
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
              const insert = tc.draw(gs.sampledFrom(["", "z", "le", "/"]));
              b.editor.view.dispatch({
                changes: { from, to, insert },
                userEvent: "input.type",
              });
              log.push(`b ${from}…${to} ${JSON.stringify(insert)}`);
            } else if (action === "b types in a's /…") {
              // One composed gesture (AGENTS.md §1.6), an order the steps
              // alone almost never draw: A types /ble, which matches all
              // along; it reaches B, who puts "ta" right after the /; it
              // comes back to A: /table, which still matches.
              const at = view.state.selection.main.head;
              const before = at === 0 ? "" : view.state.sliceDoc(at - 1, at);
              if (before === "" || /\s/.test(before)) {
                for (const char of "/ble") {
                  const caret = view.state.selection.main.head;
                  view.dispatch({
                    changes: { from: caret, insert: char },
                    selection: { anchor: caret + 1 },
                    userEvent: "input.type",
                  });
                }
                typed = slashState(view.state) ? "/ble" : null;
                a.doc.importBatch(b.held.splice(0));
                b.doc.importBatch(a.held.splice(0));
                const open = slashState(view.state);
                if (open) {
                  b.editor.view.dispatch({
                    changes: { from: open.from + 1, insert: "ta" },
                    userEvent: "input.type",
                  });
                  a.doc.importBatch(b.held.splice(0));
                  log.push(`b puts ta at ${open.from + 1}`);
                }
              }
            } else if (action === "deliver to a" && b.held.length > 0) {
              a.doc.importBatch(b.held.splice(0));
            } else if (action === "deliver to b" && a.held.length > 0) {
              b.doc.importBatch(a.held.splice(0));
            }
            const open = slashState(view.state);
            if (!open) {
              typed = null;
              continue;
            }
            const caret = view.state.selection.main.head;
            const shown = view.state.sliceDoc(open.from, caret);
            check(
              shown === `/${open.query}`,
              `open on ${JSON.stringify(shown)}, query ${JSON.stringify(open.query)} (${log})`,
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
