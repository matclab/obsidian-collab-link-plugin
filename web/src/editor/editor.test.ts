import { undo, undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type EditorFactory,
  createDocumentEditor,
  makeReadOnly,
} from "./editor.js";
import { withoutLayout } from "./test-support/no-layout.js";
import { obsidianAdding, obsidianLike } from "./test-support/obsidian-like.js";

describe("createDocumentEditor", () => {
  test("typing in the editor updates the underlying Loro text", () => {
    const doc = new LoroDoc();
    const parent = document.createElement("div");
    const editor = createDocumentEditor(parent, doc);

    editor.view.dispatch({ changes: { from: 0, insert: "Hello" } });

    expect(doc.getText("content").toString()).toBe("Hello");
  });

  test("a remote Loro update is reflected in the editor's displayed text", () => {
    const docA = new LoroDoc();
    const parent = document.createElement("div");
    const editor = createDocumentEditor(parent, docA);

    const docB = new LoroDoc();
    docB.getText("content").insert(0, "from peer B");
    docA.import(docB.export({ mode: "update" }));

    expect(editor.view.state.doc.toString()).toBe("from peer B");
  });

  test("two editors, each fed the other's Loro updates, converge after concurrent typing", () => {
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const editorA = createDocumentEditor(document.createElement("div"), docA);
    const editorB = createDocumentEditor(document.createElement("div"), docB);

    editorA.view.dispatch({ changes: { from: 0, insert: "Hello" } });
    docB.import(docA.export({ mode: "update" }));

    editorA.view.dispatch({ changes: { from: 5, insert: " Alice" } });
    editorB.view.dispatch({ changes: { from: 5, insert: " Charlie" } });
    docB.import(docA.export({ mode: "update" }));
    docA.import(docB.export({ mode: "update" }));

    expect(editorA.view.state.doc.toString()).toBe(
      editorB.view.state.doc.toString(),
    );
    expect(editorA.view.state.doc.toString()).toContain("Alice");
    expect(editorA.view.state.doc.toString()).toContain("Charlie");
  });

  // Any mutation of the Loro text that doesn't come from this editor —
  // not only a remote import, but also a local programmatic edit such as
  // accepting a suggestion (annotations/actions.ts) — must show up in the
  // view. Otherwise the view and Loro diverge, and every later keystroke is
  // applied to Loro at stale offsets: silently dropped when out of range
  // (Loro throws inside the update listener), or landing at the wrong place.
  test("a local, non-editor mutation of the Loro text is reflected in the view", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc);
    editor.view.dispatch({ changes: { from: 0, insert: "hello world" } });

    doc.getText("content").delete(0, 6);
    doc.commit();

    expect(editor.view.state.doc.toString()).toBe("world");
  });

  test("typing after a non-editor mutation lands at the intended position", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc);
    editor.view.dispatch({
      changes: { from: 0, insert: "hello world\nsecond line" },
    });
    doc.getText("content").delete(0, 6);
    doc.commit();

    editor.view.dispatch({
      changes: { from: editor.view.state.doc.length, insert: "!" },
    });

    expect(doc.getText("content").toString()).toBe("world\nsecond line!");
  });
});

describe("a read-only editor (reader, reviewer)", () => {
  // Its column scrolls by itself side by side (phase 11, decision 11): the
  // keyboard reaches it there, for every role (axe-core counts a tabindex,
  // not contenteditable).
  test("its text is in the tab order, explicitly, read-only or not", () => {
    for (const readOnly of [false, true]) {
      const doc = new LoroDoc();
      const editor = createDocumentEditor(document.createElement("div"), doc, {
        readOnly,
      });
      expect(editor.view.contentDOM.getAttribute("tabindex")).toBe("0");
    }
  });

  test("refuses the user's edits, still shows the others'", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      readOnly: true,
    });

    expect(editor.view.state.readOnly).toBe(true);
    const peer = new LoroDoc();
    peer.getText("content").insert(0, "from an editor");
    doc.import(peer.export({ mode: "update" }));
    expect(editor.view.state.doc.toString()).toBe("from an editor");
  });

  test("an editor's own is writable", () => {
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
    );

    expect(editor.view.state.readOnly).toBe(false);
  });

  // A deleted document (ADR-0023, ADR-0024): the copy stays readable.
  test("an editor's own becomes read-only, keeping its text", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "kept");
    const editor = createDocumentEditor(document.createElement("div"), doc);

    makeReadOnly(editor.view);

    expect(editor.view.state.readOnly).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("kept");
  });
});

// Phase 9, R3: CodeMirror catches what its listeners and plugins throw and
// only logs it; a Loro panic there must reach whoever halts the page.
describe("a Loro panic inside the editor", () => {
  test("is handed to onTrap", () => {
    const traps: unknown[] = [];
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      {
        onTrap: (error) => traps.push(error),
      },
    );
    const trap = new WebAssembly.RuntimeError("unreachable");
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) throw trap;
        }),
      ),
    });
    editor.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(traps).toEqual([trap]);
  });
});

// Phase 10, after delivery: a new document's editor showed nothing at all.
describe("an empty document", () => {
  test("says where to write, until there is text", () => {
    const doc = new LoroDoc();
    const parent = document.createElement("div");
    const editor = createDocumentEditor(parent, doc, {
      placeholder: "Start writing",
    });
    const shown = () =>
      parent.querySelector(".cm-placeholder")?.textContent ?? null;
    expect(shown()).toBe("Start writing");
    editor.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(shown()).toBeNull();
  });

  test("its caret takes the page's color, over CodeMirror's own black", () => {
    const parent = document.createElement("div");
    const editor = createDocumentEditor(parent, new LoroDoc());
    const rules = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    // A theme of the editor's, scoped like CodeMirror's base theme and
    // after it: it wins where a page rule lost (dark theme).
    expect(editor.view.dom.className).toMatch(/ͼ/);
    expect(rules).toMatch(/caret-color:\s*var\(--pencil\)/);
  });
});

// Phase 17, decision 4: a host (the Obsidian plugin) may bring its own
// editor; the view keeps the link to Loro, the role and the traps on it,
// and leaves it its Markdown, keys, history and formatting.
describe("an editor a host provides", () => {
  const hosted = () => {
    const made: { doc: string; destroyed: number; view?: EditorView } = {
      doc: "",
      destroyed: 0,
    };
    const provide: EditorFactory = (parent, setup) => {
      made.doc = setup.doc;
      const view = new EditorView({
        state: EditorState.create({
          doc: setup.doc,
          extensions: setup.extensions,
        }),
        parent,
      });
      made.view = view;
      return {
        view,
        destroy() {
          made.destroyed++;
          view.destroy();
        },
      };
    };
    return { made, provide };
  };

  test("is built on the text, in the element given, and is the view's", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "# Kept");
    const parent = document.createElement("div");
    const { made, provide } = hosted();

    const editor = createDocumentEditor(parent, doc, { provide });

    expect(made.doc).toBe("# Kept");
    expect(editor.view).toBe(made.view);
    expect(parent.contains(editor.view.dom)).toBe(true);
  });

  test("its typing reaches Loro, and the others' edits reach it", () => {
    const doc = new LoroDoc();
    const { provide } = hosted();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide,
    });

    editor.view.dispatch({ changes: { from: 0, insert: "Hello" } });
    expect(doc.getText("content").toString()).toBe("Hello");

    const peer = new LoroDoc();
    peer.import(doc.export({ mode: "update" }));
    peer.getText("content").insert(5, " world");
    doc.import(peer.export({ mode: "update" }));
    expect(editor.view.state.doc.toString()).toBe("Hello world");
  });

  test("keeps the role and the traps", () => {
    const traps: unknown[] = [];
    const { provide } = hosted();
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide,
      readOnly: true,
      onTrap: (error) => traps.push(error),
    });
    expect(editor.view.state.readOnly).toBe(true);

    const trap = new WebAssembly.RuntimeError("unreachable");
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) throw trap;
        }),
      ),
    });
    // A reader's text changes only by the others' (17e).
    const peer = new LoroDoc();
    peer.getText("content").insert(0, "x");
    doc.import(peer.export({ mode: "update" }));
    expect(traps).toEqual([trap]);
  });

  test("gets none of the page's Markdown, keys or history", () => {
    const { provide } = hosted();
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      { provide, livePreview: true },
    );
    expect(editor.view.state.facet(language)).toBeNull();
    editor.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(undoDepth(editor.view.state)).toBe(0);
    expect(editor.view.dom.querySelector(".cm-content")?.textContent).toBe("x");
  });

  test("is destroyed by the host's own means", () => {
    const { made, provide } = hosted();
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      { provide },
    );
    editor.destroy();
    expect(made.destroyed).toBe(1);
  });

  test("the page's editor is destroyed too", () => {
    const parent = document.createElement("div");
    const editor = createDocumentEditor(parent, new LoroDoc());
    editor.destroy();
    expect(parent.querySelector(".cm-editor")).toBeNull();
  });
});

describe("another's text and the undo history (phase 17, decision 12)", () => {
  for (const [name, provide] of [
    ["the page's editor", undefined],
    ["an editor a host provides", obsidianLike],
  ] as const) {
    test(`${name}: an undo takes back what was typed here, never another's text`, () => {
      const doc = new LoroDoc();
      const editor = createDocumentEditor(document.createElement("div"), doc, {
        ...(provide && { provide }),
      });
      editor.view.dispatch({
        changes: { from: 0, insert: "mine " },
        userEvent: "input.type",
      });
      const peer = new LoroDoc();
      peer.import(doc.export({ mode: "update" }));
      peer.getText("content").insert(5, "theirs");
      doc.import(peer.export({ mode: "update" }));

      undo(editor.view);

      expect(editor.view.state.doc.toString()).toBe("theirs");
      expect(doc.getText("content").toString()).toBe("theirs");
      expect(undo(editor.view)).toBe(false);
      // Before its scheduled measure, which jsdom cannot do.
      editor.destroy();
    });
  }

  test("another's text comes in marked remote, for the host's plugins", () => {
    const doc = new LoroDoc();
    const remote: (boolean | undefined)[] = [];
    const editor = createDocumentEditor(document.createElement("div"), doc);
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            if (tr.docChanged) remote.push(tr.annotation(Transaction.remote));
          }
        }),
      ),
    });
    editor.view.dispatch({ changes: { from: 0, insert: "a" } });
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: "update" }));
    peer.getText("content").insert(1, "b");
    doc.import(peer.export({ mode: "update" }));

    expect(remote).toEqual([undefined, true]);
  });

  test("another's text comes in marked set, as Obsidian marks a text set from outside", () => {
    const doc = new LoroDoc();
    const set: boolean[] = [];
    const editor = createDocumentEditor(document.createElement("div"), doc);
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            if (tr.docChanged) set.push(tr.isUserEvent("set"));
          }
        }),
      ),
    });
    editor.view.dispatch({
      changes: { from: 0, insert: "a" },
      userEvent: "input.type",
    });
    const peer = new LoroDoc();
    peer.import(doc.export({ mode: "update" }));
    peer.getText("content").insert(1, "b");
    doc.import(peer.export({ mode: "update" }));

    expect(set).toEqual([false, true]);
  });
});

describe("under a host's own extensions (analysis 17d, I8)", () => {
  test("a reader's editor stays read-only", () => {
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      { provide: obsidianLike, readOnly: true },
    );
    expect(editor.view.state.readOnly).toBe(true);
  });

  test("a Loro panic still reaches onTrap", () => {
    const traps: unknown[] = [];
    const editor = createDocumentEditor(
      document.createElement("div"),
      new LoroDoc(),
      { provide: obsidianLike, onTrap: (error) => traps.push(error) },
    );
    const trap = new WebAssembly.RuntimeError("unreachable");
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) throw trap;
        }),
      ),
    });
    editor.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(traps).toEqual([trap]);
  });

  // Obsidian's live preview renumbers a list, or puts a line before a
  // table, by a filter on every change it isn't told was set from
  // outside — another's text included: the editor's text then was no
  // longer Loro's, and every annotation, every cursor, every keystroke
  // landed beside its place (0.6.2).
  for (const respectsSet of [true, false]) {
    test(`another's text comes in as it is, under a filter that adds to a change${respectsSet ? "" : ", even a set"}`, () => {
      const doc = new LoroDoc();
      const editor = createDocumentEditor(document.createElement("div"), doc, {
        provide: obsidianAdding(respectsSet),
      });
      const peer = new LoroDoc();
      peer.getText("content").insert(0, "1. a\n2. b");
      doc.import(peer.export({ mode: "update" }));

      expect(editor.view.state.doc.toString()).toBe("1. a\n2. b");
      expect(doc.getText("content").toString()).toBe("1. a\n2. b");
    });
  }

  test("what a host's filter adds to a keystroke is typed here", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide: obsidianAdding(true),
    });
    editor.view.dispatch({
      changes: { from: 0, insert: "a" },
      userEvent: "input.type",
    });

    expect(editor.view.state.doc.toString()).toBe("a!");
    expect(doc.getText("content").toString()).toBe("a!");
  });
});

describe("a destroyed editor (analysis 17d, I4)", () => {
  test("no longer follows the text", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide: obsidianLike,
    });
    editor.destroy();

    const peer = new LoroDoc();
    peer.getText("content").insert(0, "late");
    doc.import(peer.export({ mode: "update" }));

    expect(editor.view.state.doc.toString()).toBe("");
  });
});

// Phase 17e (ADR-0004): readOnly stops CodeMirror's own input and
// commands, not a host's command or plugin that dispatches; a filter
// refuses any change of the text but the link's, for a reader, a reviewer
// or a deleted document.
describe("an editor that may not type", () => {
  const dispatchedEdit = (view: EditorView) =>
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input" });

  for (const [name, provide] of [
    ["the page's editor", undefined],
    ["an editor a host provides", obsidianLike],
  ] as const) {
    test(`${name}: a reader's refuses a dispatched edit, still shows the others'`, () => {
      const doc = new LoroDoc();
      const editor = createDocumentEditor(document.createElement("div"), doc, {
        readOnly: true,
        ...(provide && { provide }),
      });

      dispatchedEdit(editor.view);
      expect(editor.view.state.doc.toString()).toBe("");
      expect(doc.getText("content").toString()).toBe("");

      const peer = new LoroDoc();
      peer.getText("content").insert(0, "theirs");
      doc.import(peer.export({ mode: "update" }));
      expect(editor.view.state.doc.toString()).toBe("theirs");
    });
  }

  test("a deleted document's refuses one too", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide: obsidianLike,
    });
    makeReadOnly(editor.view);

    dispatchedEdit(editor.view);

    expect(editor.view.state.doc.toString()).toBe("");
    expect(doc.getText("content").toString()).toBe("");
  });

  test("an editor's own takes it", () => {
    const doc = new LoroDoc();
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide: obsidianLike,
    });
    dispatchedEdit(editor.view);
    expect(doc.getText("content").toString()).toBe("x");
  });
});

/** Tab, Shift+Tab or Escape pressed in `view`: whether a binding took it. */
function key(view: EditorView, name: "Tab" | "Escape", shiftKey = false) {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key: name, shiftKey }),
    "editor",
  );
}

describe("the Tab key (ADR-0054)", () => {
  // An indentation scrolls the caret into view: measured in a later frame.
  const destroyAfter = withoutLayout();
  const editorOn = (text: string, options = {}) => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, text);
    const editor = createDocumentEditor(
      document.createElement("div"),
      doc,
      options,
    );
    editor.view.dispatch({ selection: { anchor: text.length } });
    destroyAfter(editor.view);
    return { doc, editor };
  };

  test("in the page's editor, it indents, into Loro, undone in one step", () => {
    const { doc, editor } = editorOn("- a\n- b");
    expect(key(editor.view, "Tab")).toBe(true);
    expect(doc.getText("content").toString()).toBe("- a\n\t- b");
    expect(key(editor.view, "Tab", true)).toBe(true);
    expect(doc.getText("content").toString()).toBe("- a\n- b");
    key(editor.view, "Tab");
    undo(editor.view);
    expect(editor.view.state.doc.toString()).toBe("- a\n- b");
  });

  test("read-only, it is left to the browser", () => {
    const { editor } = editorOn("- a\n- b", { readOnly: true });
    expect(key(editor.view, "Tab")).toBe(false);
    expect(key(editor.view, "Tab", true)).toBe(false);
  });

  test("a host's editor keeps its own", () => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "- a\n- b");
    const editor = createDocumentEditor(document.createElement("div"), doc, {
      provide: (parent, setup) => {
        const view = new EditorView({
          state: EditorState.create({
            doc: setup.doc,
            extensions: setup.extensions,
          }),
          parent,
        });
        return { view, destroy: () => view.destroy() };
      },
    });
    editor.view.dispatch({ selection: { anchor: 7 } });
    destroyAfter(editor.view);
    expect(key(editor.view, "Tab")).toBe(false);
  });
});
