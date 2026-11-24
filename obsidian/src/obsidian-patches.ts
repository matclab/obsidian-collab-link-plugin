// What the plugin wraps of Obsidian's, each undone when the plugin is
// disabled (`register`).
import { type App, TFile, WorkspaceLeaf } from "obsidian";
import { DOCUMENT_VIEW } from "./leaf-view.js";

type Register = (undo: () => void) => void;

/** Obsidian opens every address by `window.open`: one `follow` takes is
 * opened here instead (ADR-0045); any other, by `window.open`. */
export function followAddresses(
  register: Register,
  follow: (href: string, open: typeof window.open) => boolean,
): void {
  const open = window.open;
  window.open = ((url?: string | URL, ...rest: string[]) => {
    if (url !== undefined && follow(String(url), open)) {
      return null;
    }
    return open.call(window, url, ...rest);
  }) as typeof window.open;
  register(() => {
    window.open = open;
  });
}

/** Obsidian tells its tabs' editors that its options changed (a plugin's
 * editor extension registered); `updated` tells the views' (ADR-0039). */
export function followObsidianOptions(
  app: App,
  register: Register,
  updated: () => void,
): void {
  const { workspace } = app;
  const original = workspace.updateOptions;
  workspace.updateOptions = (...args) => {
    original.apply(workspace, args);
    updated();
  };
  register(() => {
    workspace.updateOptions = original;
  });
}

/** A note whose file carries `collab-document` opens in the plugin's view,
 * however Obsidian opens it — but its own reading view. */
export function openLinkedNotesInTheView(
  app: App,
  register: Register,
  isLinked: (file: TFile) => Promise<boolean>,
): void {
  const original = WorkspaceLeaf.prototype.setViewState;
  WorkspaceLeaf.prototype.setViewState = async function (
    this: WorkspaceLeaf,
    state,
    ...rest
  ) {
    const path = state.state?.file;
    if (
      state.type === "markdown" &&
      typeof path === "string" &&
      state.state?.mode !== "preview"
    ) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && (await isLinked(file))) {
        return original.call(this, { ...state, type: DOCUMENT_VIEW }, ...rest);
      }
    }
    return original.call(this, state, ...rest);
  };
  register(() => {
    WorkspaceLeaf.prototype.setViewState = original;
  });
}
