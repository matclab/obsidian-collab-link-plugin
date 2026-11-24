// @vitest-environment jsdom
//
// Moving a section from the editor (phase 17, decision 7): one
// transaction, which the link to Loro publishes as a keystroke; the caret
// stays where it was in the section; nothing for an editor that may not
// type, nor for a move that would change the text's meaning.
import { StateEffect } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test } from "vitest";
import { createDocumentEditor } from "./editor.js";
import { moveSectionBy } from "./section-commands.js";
import { obsidianLike } from "./test-support/obsidian-like.js";

const TEXT = "# A\na\n# B\nbé\n";

// Destroyed before their scheduled measure (a move scrolls), which jsdom
// can't do.
const made: { destroy(): void }[] = [];
afterEach(() => {
  for (const editor of made.splice(0)) editor.destroy();
});

function editor(options: { readOnly?: boolean; hosted?: boolean } = {}) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, TEXT);
  doc.commit();
  const built = createDocumentEditor(document.createElement("div"), doc, {
    readOnly: options.readOnly ?? false,
    ...(options.hosted && { provide: obsidianLike }),
  });
  made.push(built);
  return { doc, editor: built, view: built.view };
}

describe("moving a section from the editor", () => {
  for (const hosted of [false, true]) {
    test(`${hosted ? "a host's" : "the page's"} editor: one transaction, in Loro, the caret kept in its section`, () => {
      const { doc, view } = editor({ hosted });
      const caret = TEXT.indexOf("é");
      view.dispatch({ selection: { anchor: caret } });
      let transactions = 0;
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          EditorView.updateListener.of((update) => {
            transactions += update.transactions.filter(
              (tr) => tr.docChanged,
            ).length;
          }),
        ),
      });

      expect(moveSectionBy(view, "up")).toBe(true);

      expect(view.state.doc.toString()).toBe("# B\nbé\n# A\na\n");
      expect(doc.getText("content").toString()).toBe("# B\nbé\n# A\na\n");
      expect(view.state.selection.main.head).toBe("# B\nb".length);
      expect(transactions).toBe(1);
    });
  }

  test("nothing where it can't move", () => {
    const { view } = editor();
    view.dispatch({ selection: { anchor: 0 } });
    expect(moveSectionBy(view, "up")).toBe(false);
    expect(view.state.doc.toString()).toBe(TEXT);
  });

  test("nothing for an editor that may not type", () => {
    const { doc, view } = editor({ readOnly: true, hosted: true });
    view.dispatch({ selection: { anchor: TEXT.indexOf("é") } });
    expect(moveSectionBy(view, "up")).toBe(false);
    expect(doc.getText("content").toString()).toBe(TEXT);
  });

  test("in the page's editor, Ctrl/Cmd+Shift+Up and Down", () => {
    const { view } = editor();
    view.dispatch({ selection: { anchor: TEXT.indexOf("é") } });
    const key = (key: string) =>
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true }),
        "editor",
      );
    expect(key("ArrowUp")).toBe(true);
    expect(view.state.doc.toString()).toBe("# B\nbé\n# A\na\n");
    expect(key("ArrowDown")).toBe(true);
    expect(view.state.doc.toString()).toBe(TEXT);
  });
});

// Decision 7, its limit, written down: Loro's text has no move; an edit of
// another's not received yet when the section moves lands where it was
// typed. In the neighbour, left as it is, it stays in its section; in the
// moved section, it stays at the old place, alone.
describe("an edit of another's on its way during a move", () => {
  test("in the neighbour: kept in its section; in the moved one: at the old place", () => {
    const { doc, view } = editor();
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: "update" }));
    // Typed by the other, not received yet: in A (the neighbour), in B.
    const text = peer.getText("content");
    text.insert("# A\na".length, " (A)");
    text.insert(TEXT.indexOf("é") + 1, " (B)");
    peer.commit();

    view.dispatch({ selection: { anchor: TEXT.indexOf("é") } });
    expect(moveSectionBy(view, "up")).toBe(true);
    doc.import(peer.export({ mode: "update" }));
    peer.import(doc.export({ mode: "update" }));

    const merged = doc.getText("content").toString();
    expect(merged).toBe(peer.getText("content").toString());
    expect(view.state.doc.toString()).toBe(merged);
    // A's edit in A; B's at the old place, here glued to A's last line.
    expect(merged).toBe("# B\nbé\n# A\na (A) (B)\n");
  });
});
