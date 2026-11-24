import { EditorSelection, EditorState } from "@codemirror/state";
// The / menu's invariant (phase 20, WA4), over the user's own actions:
// open, it is the /… just before the caret; a close never changes the
// text; a choice is the /… taken out, then the construction applied —
// or a callout of a family (ADR-0063), read back as that family.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, describe, test } from "vitest";
import { setLanguage } from "../i18n/index.js";
import {
  CALLOUT_FAMILIES,
  calloutHeader,
  defaultCalloutTitle,
} from "../render/index.js";
import { calloutName } from "./construct-name.js";
import { markdownSyntax } from "./markdown-syntax.js";
import {
  chooseSlash,
  closeSlash,
  moveSlash,
  slashMatches,
  slashMenu,
  slashState,
  slashTransaction,
} from "./slash-menu.js";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const ACTIONS = [
  "type",
  "type",
  "type",
  "delete",
  "caret",
  "escape",
  "down",
  "choose",
] as const;

describe("the / menu (property)", () => {
  test(
    "open, the /… before the caret; closed, the text unchanged; chosen, the /… out and the construction in",
    () =>
      hegel.test(
        (tc) => {
          let state = EditorState.create({
            doc: tc.draw(gs.sampledFrom(["", "a b", "# t\n\n- x", "`c`\n"])),
            extensions: [markdownSyntax(), slashMenu()],
          });
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
          const log: string[] = [];
          for (let step = 0; step < steps; step++) {
            const action = tc.draw(gs.sampledFrom([...ACTIONS]));
            const before = state;
            const text = before.doc.toString();
            const head = before.selection.main.head;
            if (action === "type") {
              const char = tc.draw(
                gs.sampledFrom([
                  "/",
                  "/",
                  "t",
                  "a",
                  "b",
                  "h",
                  "i",
                  "w",
                  " ",
                  "\n",
                ]),
              );
              state = state.update({
                changes: { from: head, insert: char },
                selection: { anchor: head + 1 },
                userEvent: "input.type",
              }).state;
              log.push(JSON.stringify(char));
            } else if (action === "delete" && head > 0) {
              state = state.update({
                changes: { from: head - 1, to: head },
                userEvent: "delete.backward",
              }).state;
              log.push("⌫");
            } else if (action === "caret") {
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: text.length }),
              );
              state = state.update({
                selection: EditorSelection.cursor(at),
                userEvent: "select",
              }).state;
              log.push(`caret ${at}`);
            } else if (action === "escape" || action === "down") {
              state = state.update(
                action === "escape" ? closeSlash(state) : moveSlash(state, 1),
              ).state;
              log.push(action);
              check(
                state.doc.toString() === text,
                `${action} changed the text: ${log}`,
              );
            } else if (action === "choose") {
              const open = slashState(before);
              const spec = chooseSlash(before);
              log.push("choose");
              if (!open || !spec) continue;
              state = before.update(spec).state;
              // The two steps, one after the other: what the one
              // transaction has to give.
              const end = open.from + 1 + open.query.length;
              const without = before.update({
                changes: { from: open.from, to: end },
                selection: { anchor: open.from },
              }).state;
              const id = open.matches[open.active];
              const applied = id && slashTransaction(without, id);
              const expected = applied ? without.update(applied).state : before;
              check(
                state.doc.toString() === expected.doc.toString(),
                `chosen ${id}: ${JSON.stringify(state.doc.toString())} ≠ ${JSON.stringify(expected.doc.toString())} after ${log}`,
              );
              check(
                slashState(state) === null,
                `still open after a choice: ${log}`,
              );
            }
            const open = slashState(state);
            if (open) {
              const caret = state.selection.main.head;
              const typed = state.sliceDoc(open.from, caret);
              check(
                typed === `/${open.query}`,
                `open on ${JSON.stringify(typed)}, query ${JSON.stringify(open.query)}: ${log}`,
              );
              check(
                // No image here: nothing inserts one (ADR-0057 §8).
                JSON.stringify(open.matches) ===
                  JSON.stringify(
                    slashMatches(open.query).filter((id) => id !== "image"),
                  ) &&
                  open.matches.length > 0 &&
                  open.active < open.matches.length,
                `matches of ${JSON.stringify(open.query)}: ${log}`,
              );
            }
          }
        },
        { testCases: 400 },
      ),
    20_000,
  );

  afterEach(() => setLanguage("en"));

  test("a family chosen: a callout of that family, its title the family's name in the page's language, Obsidian's when that is the same (ADR-0063, EN3)", () =>
    hegel.test(
      (tc) => {
        setLanguage(tc.draw(gs.sampledFrom(["en", "fr"] as const)));
        const family = tc.draw(gs.sampledFrom([...CALLOUT_FAMILIES]));
        const text = tc.draw(
          gs.sampledFrom(["", "a b", "# t\n\n- x", "> q", "```\nc\n```"]),
        );
        const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
        const state = EditorState.create({
          doc: text,
          selection: EditorSelection.cursor(at),
          extensions: [markdownSyntax()],
        });
        const spec = slashTransaction(state, `callout:${family}`);
        if (!spec)
          throw new Error(`nothing inserted in ${JSON.stringify(text)}`);
        const after = state.update(spec).state;
        const caret = after.doc.lineAt(after.selection.main.head);
        const header = calloutHeader(after.doc.line(caret.number - 1).text);
        const shown = header?.title || defaultCalloutTitle(header?.type ?? "");
        check(
          header?.family === family &&
            header.type === family &&
            shown === calloutName(family) &&
            caret.text === "> ",
          `${family} in ${JSON.stringify(text)} at ${at}: ${JSON.stringify(after.doc.toString())}`,
        );
      },
      { testCases: 300 },
    ));
});
