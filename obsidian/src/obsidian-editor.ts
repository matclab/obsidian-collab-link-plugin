import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, Component, TFile } from "obsidian";
import type { EditorFactory } from "../../web/src/embed.js";

/** Obsidian's own editor, the one of its tabs: not in its API. What the plugin
 * uses of it, as read in `app.js` 1.14.4 (written from Obsidian, the way known
 * from Kanban, nothing copied). */
interface ObsidianEditor extends Component {
  readonly cm: EditorView;
  /** Its element, in the one it was built in. */
  readonly editorEl?: HTMLElement;
  /** Its `Editor`, as the API gives a tab's. */
  readonly editor: unknown;
  buildLocalExtensions(): Extension[];
  /** The first time, its state: never again (another time, a difference applied
   * as `"set"`; phase 17, P4). */
  set(text: string): void;
  updateOptions(): void;
  showSearch(replace?: boolean): void;
  destroy(): void;
}

type ObsidianEditorClass = new (
  app: App,
  containerEl: HTMLElement,
  owner: unknown,
) => ObsidianEditor;

interface MarkdownEmbed {
  editable: boolean;
  editMode?: { cm?: unknown };
  load(): void;
  showEditor(): void;
  unload(): void;
}

/** Obsidian's editor class, from the editor of an embedded note (the prototype
 * of its prototype); none if Obsidian has changed: no such embed, a failure, or
 * a CodeMirror that isn't the plugin's. */
export function obsidianEditorClass(app: App): ObsidianEditorClass | undefined {
  try {
    const registry = (
      app as unknown as {
        embedRegistry?: {
          embedByExtension?: Record<string, (...args: unknown[]) => unknown>;
        };
      }
    ).embedRegistry;
    const md = registry?.embedByExtension?.md;
    if (typeof md !== "function") return undefined;
    const containerEl = document.createElement("div");
    const embed = md({ app, containerEl, state: {} }, null, "") as
      | MarkdownEmbed
      | undefined;
    if (!embed) return undefined;
    try {
      embed.load();
      embed.editable = true;
      embed.showEditor();
      const editMode = embed.editMode;
      if (!editMode || !(editMode.cm instanceof EditorView)) return undefined;
      const found = Object.getPrototypeOf(Object.getPrototypeOf(editMode))
        ?.constructor as ObsidianEditorClass | undefined;
      const proto = found?.prototype as Partial<ObsidianEditor> | undefined;
      const methods = [
        "buildLocalExtensions",
        "set",
        "updateOptions",
        "showSearch",
        "destroy",
      ] as const;
      return proto && methods.every((name) => typeof proto[name] === "function")
        ? found
        : undefined;
    } finally {
      embed.unload();
    }
  } catch (error) {
    console.warn("Collab Link: Obsidian's editor", error);
    return undefined;
  }
}

/** The editors of Obsidian's the plugin's views write in, children of the
 * plugin. */
export class ObsidianEditors {
  private readonly mounted = new Set<ObsidianEditor>();

  constructor(
    private readonly app: App,
    private readonly owner: Component,
    private readonly editorClass: ObsidianEditorClass,
    /** The plugin's own, for a note's editor (its links). */
    private readonly own: (note: () => TFile | null) => Extension[] = () => [],
  ) {}

  /** For a view of `note`: built with the view's extensions after Obsidian's
   * own (they take precedence where it matters, I8). */
  factory(note: () => TFile | null): EditorFactory {
    return (parent, setup) => {
      const { app } = this;
      // The editor's owner, as a tab is: what Obsidian's commands act on
      // (`workspace.activeEditor`), and where it asks for the file.
      const controller = {
        app,
        get file() {
          return note();
        },
        get path() {
          return note()?.path ?? "";
        },
        get editor() {
          return editor.editor;
        },
        get editMode() {
          return editor;
        },
        getMode: () => "source",
        showSearch: (replace?: boolean) => editor.showSearch(replace),
        toggleMode() {},
        onMarkdownScroll() {},
        scroll: 0,
      };
      const own = this.own(note);
      class InTheView extends this.editorClass {
        override buildLocalExtensions(): Extension[] {
          return [...super.buildLocalExtensions(), ...setup.extensions, ...own];
        }
      }
      const editor = this.owner.addChild(
        new InTheView(app, parent as HTMLElement, controller),
      );
      editor.set(setup.doc);
      this.mounted.add(editor);
      const workspace = app.workspace as unknown as {
        activeEditor: unknown;
        unsetActiveEditor(editor?: unknown): void;
      };
      // Focused, its the editor Obsidian's commands act on (EH3).
      const focus = () => {
        workspace.activeEditor = controller;
      };
      const { contentDOM } = editor.cm;
      contentDOM.addEventListener("focus", focus);
      return {
        view: editor.cm,
        ...(editor.editorEl && { element: editor.editorEl }),
        destroy: () => {
          this.mounted.delete(editor);
          contentDOM.removeEventListener("focus", focus);
          // No command on a destroyed editor (I7).
          workspace.unsetActiveEditor(controller);
          // As Obsidian takes its own out of a tab.
          editor.destroy();
          this.owner.removeChild(editor);
          editor.editorEl?.remove();
        },
      };
    };
  }

  /** Obsidian's options changed (`workspace.updateOptions`: a plugin's
   * extension registered, a setting): each editor reads them again. */
  updateOptions(): void {
    for (const editor of this.mounted) editor.updateOptions();
  }
}
