import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
// @vitest-environment jsdom
// The formatting commands in the page's editor (phase 20a.3, a.4): an
// annotation keeps its passage, the shortcuts reach the commands.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { anchorRange, resolveRange } from "../../lib/src/annotations/index.js";
import { CONSTRUCTS, type ConstructId } from "./constructs.js";
import { createDocumentEditor } from "./editor.js";
import { constructTransaction } from "./format-commands.js";
import { withoutLayout } from "./test-support/no-layout.js";

const destroyed = withoutLayout();

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The page's editor on `text`, the selection `anchor`…`head`, and an
 * annotation anchored on `start`…`end`, as the page anchors one. */
function annotated(text: string, start: number, end: number) {
  const doc = new LoroDoc();
  const editor = createDocumentEditor(document.createElement("div"), doc);
  destroyed(editor.view);
  editor.view.dispatch({ changes: { from: 0, insert: text } });
  const anchor = anchorRange(doc.getText("content"), start, end);
  if (!anchor) throw new Error("not anchored");
  return {
    editor,
    apply(id: ConstructId, from: number, to: number): boolean {
      editor.view.dispatch({ selection: EditorSelection.single(from, to) });
      const spec = constructTransaction(editor.view.state, id);
      if (spec) editor.view.dispatch(spec);
      return spec !== null;
    },
    passage(): string {
      const range = resolveRange(doc, anchor);
      return range ? editor.view.state.sliceDoc(range.start, range.end) : "";
    },
  };
}

describe("an annotation and the formatting", () => {
  test("bold on a commented passage: the comment on the same words", () => {
    const it = annotated("a commented passage b", 2, 19);
    expect(it.apply("bold", 2, 19)).toBe(true);
    expect(it.editor.view.state.doc.toString()).toBe(
      "a **commented passage** b",
    );
    expect(it.passage()).toBe("commented passage");
  });

  test("a link on a commented word: the comment on the word (found by the property)", () => {
    const it = annotated("w0 ", 0, 1);
    expect(it.apply("link", 0, 1)).toBe(true);
    expect(it.editor.view.state.doc.toString()).toBe("[w]()0 ");
    expect(it.passage()).toBe("w");
  });

  test("a heading on a commented line: the comment on its text", () => {
    const it = annotated("line\nnext", 0, 4);
    expect(it.apply("heading2", 2, 2)).toBe(true);
    expect(it.passage()).toBe("line");
  });

  // Its letters and digits, without what the commands add: a list's
  // numbers, a footnote's reference. A block put in the middle of a
  // passage over several blocks goes in it, as typing would: not here.
  const letters = (passage: string) =>
    passage.replace(/\[\^\d+\]|^\d+\. /gm, "").replace(/[^a-z0-9]/g, "");

  test(
    "whatever the construct and the passage, it keeps its letters (property)",
    () =>
      hegel.test(
        (tc) => {
          const words = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
          const text = Array.from({ length: words }, (_, i) =>
            tc.draw(
              gs.sampledFrom([`w${i} `, `w${i}\n`, `w${i}\n\n`, `- w${i}\n`]),
            ),
          ).join("");
          const start = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length - 1 }),
          );
          const end = tc.draw(
            gs.integers({ minValue: start + 1, maxValue: text.length }),
          );
          const it = annotated(text, start, end);
          const before = letters(it.passage());
          const id = tc.draw(
            gs.sampledFrom(
              CONSTRUCTS.filter((each) => each.kind !== "block").map(
                (each) => each.id,
              ),
            ),
          );
          const from = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length }),
          );
          const to = tc.draw(
            gs.integers({ minValue: from, maxValue: text.length }),
          );
          it.apply(id, from, to);
          const after = letters(it.passage());
          check(
            after === before,
            `${id} on ${from}…${to} of ${JSON.stringify(text)}, annotated ${start}…${end}: ${before} → ${after} in ${JSON.stringify(it.editor.view.state.doc.toString())}`,
          );
          it.editor.destroy();
        },
        { testCases: 300 },
      ),
    20_000,
  );
});

/** A key as a layout gives it: what `key` is, the physical key's
 * `keyCode`, the modifiers. */
function press(
  view: EditorView,
  init: {
    key: string;
    keyCode: number;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  },
): boolean {
  const event = new KeyboardEvent("keydown", {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
  });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  return runScopeHandlers(view, event, "editor");
}

/** The page's editor on `text`, put in Loro first: a link that may not
 * type takes no text from its editor. */
function pageEditor(text: string, from: number, to: number, readOnly = false) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const editor = createDocumentEditor(document.createElement("div"), doc, {
    readOnly,
  });
  destroyed(editor.view);
  editor.view.dispatch({ selection: EditorSelection.single(from, to) });
  return editor;
}

describe("the shortcuts (20a.4)", () => {
  const cases: [string, Parameters<typeof press>[1], string][] = [
    [
      "Ctrl+B, QWERTY or AZERTY",
      { key: "b", keyCode: 66, ctrl: true },
      "a **b** c",
    ],
    [
      "Ctrl+B as Playwright sends it",
      { key: "B", keyCode: 66, ctrl: true },
      "a **b** c",
    ],
    ["Ctrl+I", { key: "i", keyCode: 73, ctrl: true }, "a *b* c"],
    ["Ctrl+E", { key: "e", keyCode: 69, ctrl: true }, "a `b` c"],
    [
      "Ctrl+Shift+X",
      { key: "X", keyCode: 88, ctrl: true, shift: true },
      "a ~~b~~ c",
    ],
    ["Ctrl+K", { key: "k", keyCode: 75, ctrl: true }, "a [b]() c"],
  ];
  for (const [name, key, expected] of cases) {
    test(name, () => {
      const editor = pageEditor("a b c", 2, 3);
      expect(press(editor.view, key)).toBe(true);
      expect(editor.view.state.doc.toString()).toBe(expected);
    });
  }

  test("AltGr (Ctrl+Alt) typing a character runs none", () => {
    // AZERTY: AltGr+E is €, AltGr+3 is #.
    const editor = pageEditor("a b c", 2, 3);
    press(editor.view, { key: "€", keyCode: 69, ctrl: true, alt: true });
    press(editor.view, { key: "#", keyCode: 51, ctrl: true, alt: true });
    expect(editor.view.state.doc.toString()).toBe("a b c");
  });

  test("a command that does nothing still keeps the key from the browser", () => {
    // Ctrl+B would open Firefox's bookmarks.
    const editor = pageEditor("a   c", 1, 4);
    expect(press(editor.view, { key: "b", keyCode: 66, ctrl: true })).toBe(
      true,
    );
    expect(editor.view.state.doc.toString()).toBe("a   c");
  });

  test("not for a link that may not type", () => {
    const editor = pageEditor("a b c", 2, 3, true);
    expect(press(editor.view, { key: "b", keyCode: 66, ctrl: true })).toBe(
      false,
    );
    expect(editor.view.state.doc.toString()).toBe("a b c");
  });

  test("not in a host's editor, which has its own (WA5)", () => {
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      {
        provide: (parent, { doc, extensions }) => {
          const view = new EditorView({
            parent,
            state: EditorState.create({ doc, extensions }),
          });
          return { view, destroy: () => view.destroy() };
        },
      },
    );
    destroyed(editor.view);
    editor.view.dispatch({ changes: { from: 0, insert: "a b c" } });
    editor.view.dispatch({ selection: EditorSelection.single(2, 3) });
    press(editor.view, { key: "b", keyCode: 66, ctrl: true });
    expect(editor.view.state.doc.toString()).toBe("a b c");
  });
});
