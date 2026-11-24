// @vitest-environment jsdom
//
// Obsidian's own editor in the view (phase 17, decisions 4, 5, 8, 9),
// against the fake of its internals (`test-support/obsidian.ts`, as read in
// `app.js` 1.14.4); the real one in `npm run test:e2e`.
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import { ObsidianEditors, obsidianEditorClass } from "./obsidian-editor.js";
import {
  App as FakeApp,
  FakeMarkdownEditor,
  Plugin,
  TFile,
} from "./test-support/obsidian.js";

function setUp() {
  const app = new FakeApp();
  const plugin = new Plugin(app, { id: "collab-link" });
  const note = new TFile("Note.md");
  const parent = document.createElement("div");
  document.body.append(parent);
  return { app, plugin, note, parent };
}

describe("Obsidian's editor class", () => {
  test("is found through the editor of an embedded note", () => {
    const { app } = setUp();
    expect(obsidianEditorClass(app as never)).toBe(FakeMarkdownEditor);
  });

  test("is not found when Obsidian has no such embed", () => {
    const { app } = setUp();
    app.embedRegistry = undefined;
    expect(obsidianEditorClass(app as never)).toBeUndefined();
  });

  test("is not found when the embed fails", () => {
    const { app } = setUp();
    app.embedRegistry = {
      embedByExtension: {
        md: () => {
          throw new Error("changed");
        },
      },
    };
    expect(obsidianEditorClass(app as never)).toBeUndefined();
  });

  test("is not found when its CodeMirror is not the plugin's", () => {
    const { app } = setUp();
    const md = app.embedRegistry?.embedByExtension.md;
    app.embedRegistry = {
      embedByExtension: {
        md: (...args: unknown[]) => {
          const embed = md?.(...args) as {
            showEditor(): void;
            editMode: { cm: unknown };
          };
          const show = embed.showEditor.bind(embed);
          embed.showEditor = () => {
            show();
            Object.defineProperty(embed.editMode, "cm", { value: {} });
          };
          return embed;
        },
      },
    };
    expect(obsidianEditorClass(app as never)).toBeUndefined();
  });
});

describe("an editor of Obsidian's in the view", () => {
  function mounted(options: { readOnly?: boolean } = {}) {
    const context = setUp();
    const { app, plugin, note, parent } = context;
    const editors = new ObsidianEditors(
      app as never,
      plugin as never,
      FakeMarkdownEditor as never,
    );
    // The view's extensions (the page's, 17c): here, a listener and the
    // role, ahead of Obsidian's own as the view puts it.
    const seen: string[] = [];
    const editor = editors.factory(() => note as never)(parent, {
      doc: "# Title\n",
      extensions: [
        Prec.highest(EditorState.readOnly.of(options.readOnly ?? false)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) seen.push(update.state.doc.toString());
        }),
      ],
    });
    const obsidian = plugin[
      "children" as never
    ] as unknown as FakeMarkdownEditor[];
    return {
      ...context,
      editors,
      seen,
      editor,
      obsidian: obsidian[0] as FakeMarkdownEditor,
    };
  }

  test("is Obsidian's, on the text, in the view's element, a child of the plugin", () => {
    const { editor, obsidian, parent } = mounted();
    expect(obsidian).toBeInstanceOf(FakeMarkdownEditor);
    expect(editor.view).toBe(obsidian.cm);
    expect(editor.view).toBeInstanceOf(EditorView);
    expect(editor.view.state.doc.toString()).toBe("# Title\n");
    expect(editor.view.state.facet(EditorState.readOnly)).toBe(false);
    expect(parent.contains(obsidian.editorEl)).toBe(true);
    expect(obsidian.loaded).toBe(true);
    // What the view hides in History: Obsidian's element, not only
    // CodeMirror's.
    expect(editor.element).toBe(obsidian.editorEl);
  });

  test("keeps the view's extensions, with Obsidian's", () => {
    const { editor, seen } = mounted();
    editor.view.dispatch({ changes: { from: 8, insert: "typed" } });
    expect(seen).toEqual(["# Title\ntyped"]);

    const reader = mounted({ readOnly: true });
    expect(reader.editor.view.state.readOnly).toBe(true);
  });

  test("with the plugin's own extensions for its note, after the view's (phase 19)", () => {
    const context = setUp();
    const { app, plugin, note, parent } = context;
    const asked: unknown[] = [];
    const editors = new ObsidianEditors(
      app as never,
      plugin as never,
      FakeMarkdownEditor as never,
      (forNote) => {
        asked.push(forNote());
        return [EditorState.languageData.of(() => [{ plugin: "collab" }])];
      },
    );
    const editor = editors.factory(() => note as never)(parent, {
      doc: "",
      extensions: [],
    });
    expect(asked).toEqual([note]);
    expect(editor.view.state.languageDataAt("plugin", 0)).toEqual(["collab"]);
  });

  test("focused, it is the one Obsidian's commands act on, for the note", () => {
    const { app, editor, obsidian, note } = mounted();
    editor.view.contentDOM.dispatchEvent(new FocusEvent("focus"));
    const active = app.workspace.activeEditor as unknown as {
      file: unknown;
      path: string;
      editor: unknown;
      getMode(): string;
      showSearch(): void;
    };
    expect(active.file).toBe(note);
    expect(active.path).toBe("Note.md");
    expect(active.editor).toBe(obsidian.editor);
    expect(active.getMode()).toBe("source");
    active.showSearch();
    expect(obsidian.searches).toBe(1);
  });

  test("destroyed, Obsidian's commands no longer reach it, and it leaves the view", () => {
    const { app, editor, obsidian, parent } = mounted();
    editor.view.contentDOM.dispatchEvent(new FocusEvent("focus"));
    editor.destroy();
    expect(app.workspace.activeEditor).toBeNull();
    expect(obsidian.destroyed).toBe(true);
    expect(obsidian.loaded).toBe(false);
    expect(parent.contains(obsidian.editorEl)).toBe(false);
  });

  test("another note's editor, active, stays so when this one goes", () => {
    const { app, editor } = mounted();
    const other = { file: null };
    app.workspace.activeEditor = other;
    editor.destroy();
    expect(app.workspace.activeEditor).toBe(other);
  });

  // Decision 8: a plugin enabled after the view opened reaches it.
  test("reads Obsidian's options again when told, while mounted", () => {
    const { editors, editor, obsidian } = mounted();
    editors.updateOptions();
    expect(obsidian.options).toBe(1);
    editor.destroy();
    editors.updateOptions();
    expect(obsidian.options).toBe(1);
  });
});
