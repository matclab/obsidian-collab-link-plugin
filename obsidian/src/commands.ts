import {
  type App,
  MarkdownView,
  Notice,
  type Plugin,
  type TFile,
} from "obsidian";
import { t } from "../../web/src/embed.js";
import { DocumentLeafView } from "./leaf-view.js";
import { OpenLinkModal } from "./open-link-modal.js";
import { ShareModal } from "./share-modal.js";

/** What the commands need of the plugin. */
export interface CommandsHost {
  app: App;
  track<T>(work: Promise<T>): Promise<T>;
  /** Opens a link's document in its note, a failure said. */
  openPasted(text: string): Promise<void>;
  showMyDocuments(): Promise<void>;
  /** « Ouvrir un document de Mes documents ». */
  chooseFromMyDocuments(): Promise<void>;
  share(file: TFile): Promise<void>;
}

/** The plugin's commands, in Obsidian's palette; the hotkeys are the
 * user's to choose. */
export function addCommands(plugin: Plugin, host: CommandsHost): void {
  const { app, track } = host;
  const activeView = () => app.workspace.getActiveViewOfType(DocumentLeafView);
  plugin.addCommand({
    id: "open-link",
    name: t().pluginOpenLink,
    callback: () =>
      new OpenLinkModal(
        app,
        (text) => void track(host.openPasted(text)),
      ).open(),
  });
  const showMyDocuments = () => void track(host.showMyDocuments());
  plugin.addRibbonIcon("library", t().pluginMyDocuments, showMyDocuments);
  plugin.addCommand({
    id: "my-documents",
    name: t().pluginMyDocuments,
    callback: showMyDocuments,
  });
  plugin.addCommand({
    id: "open-from-my-documents",
    name: t().pluginOpenFromMyDocuments,
    callback: () => void track(host.chooseFromMyDocuments()),
  });
  plugin.addCommand({
    id: "unlink-note",
    name: t().pluginUnlink,
    checkCallback: (checking) => {
      const view = activeView();
      if (!view) return false;
      if (!checking) void track(view.unlink());
      return true;
    },
  });
  // What typing didn't convert (a note shared since, the page's editor).
  plugin.addCommand({
    id: "convert-links",
    name: t().pluginConvertLinks,
    checkCallback: (checking) => {
      const view = activeView();
      if (!view?.file) return false;
      if (!checking) {
        const converted = view.convertLinks();
        new Notice(
          converted === undefined
            ? t().pluginConvertLinksNotEditor
            : t().pluginLinksConverted(converted),
        );
      }
      return true;
    },
  });
  plugin.addCommand({
    id: "obsidian-preview",
    name: t().pluginObsidianPreview,
    checkCallback: (checking) => {
      const file = activeView()?.file;
      if (!file) return false;
      if (!checking) void track(previewAlongside(app, file));
      return true;
    },
  });
  for (const [id, name, direction] of [
    ["move-section-up", t().pluginMoveSectionUp, "up"],
    ["move-section-down", t().pluginMoveSectionDown, "down"],
  ] as const) {
    plugin.addCommand({
      id,
      name,
      checkCallback: (checking) => {
        const view = activeView();
        if (!view?.canMoveSection()) return false;
        if (!checking) view.moveSection(direction);
        return true;
      },
    });
  }
  // ADR-0050 §5: what awaits my reply.
  for (const [id, name, by] of [
    ["previous-awaiting", t().previousAwaiting, -1],
    ["next-awaiting", t().nextAwaiting, 1],
  ] as const) {
    plugin.addCommand({
      id,
      name,
      checkCallback: (checking) =>
        activeView()?.stepAwaiting(by, checking) ?? false,
    });
  }
  plugin.addCommand({
    id: "share-note",
    name: t().pluginShareNote,
    checkCallback: (checking) => {
      const file = app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;
      if (activeView()) return false;
      if (!checking) {
        new ShareModal(app, () => void track(host.share(file))).open();
      }
      return true;
    },
  });
}

/** The note's file in Obsidian's own reading view, beside the plugin's —
 * diagrams, callouts, `[[links]]`, as Obsidian renders them. Reading only:
 * typing there would be a change from outside. The pane already open on
 * it, if any, is shown. */
async function previewAlongside(app: App, file: TFile): Promise<void> {
  const open = app.workspace
    .getLeavesOfType("markdown")
    .find(
      (leaf) => leaf.view instanceof MarkdownView && leaf.view.file === file,
    );
  if (open) {
    app.workspace.setActiveLeaf(open, { focus: true });
    return;
  }
  await app.workspace.getLeaf("split", "vertical").setViewState({
    type: "markdown",
    state: { file: file.path, mode: "preview" },
    active: true,
  });
}
