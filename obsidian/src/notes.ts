import { type App, Notice, type TFile, normalizePath } from "obsidian";
import { t } from "../../web/src/embed.js";
import { fileDate } from "./file-date.js";
import type { DocumentLeafView } from "./leaf-view.js";
import type { LinkStore } from "./link-store.js";
import { parseDocumentLink } from "./link.js";
import type { LinkedNotes } from "./linked-notes.js";
import type { LiveViews } from "./live-views.js";
import { readLooseHeader, writeHeader } from "./note-header.js";
import type { PluginSettings } from "./plugin-settings.js";
import type { PluginStorage } from "./plugin-storage.js";

/** What a file name can't hold, on any of the systems Obsidian runs on. */
const NOT_IN_NAMES = /[\\/:*?"<>|#^[\]]/g;

/** What the notes need of the plugin. */
export interface NotesHost {
  app: App;
  settings: PluginSettings;
  storage: PluginStorage;
  links: LinkStore;
  views: LiveViews<DocumentLeafView>;
  /** The vault's linked notes, by their document (LN1–LN3). */
  index: LinkedNotes;
  track<T>(work: Promise<T>): Promise<T>;
}

/** The vault's linked notes: found by their document, made for a link opened,
 * named after their title, a change from outside kept beside. */
export class VaultNotes {
  /** Notes created by "Open a link": named after their title while their view
   * shows them, this session. */
  private readonly unnamed = new Set<TFile>();

  constructor(private readonly host: NotesHost) {}

  /** A note just created by "Open a link", for its first view only. */
  takeFresh(file: TFile): boolean {
    return this.unnamed.delete(file);
  }

  /** Renames `file` after `title`; resolves with its new name. */
  nameAfter(file: TFile, title: string): Promise<string> {
    return this.host.track(
      (async () => {
        const base = title.replace(NOT_IN_NAMES, " ").trim();
        if (!base || !file.parent || file.basename === base) {
          return file.basename;
        }
        const folder = file.parent.path === "/" ? "" : file.parent.path;
        await this.host.app.fileManager.renameFile(
          file,
          this.freePath(folder, base),
        );
        return file.basename;
      })(),
    );
  }

  /** Keeps a change from outside in a new note beside `note`; resolves with it.
   */
  async keepCopy(note: TFile, text: string): Promise<TFile> {
    const folder = note.parent?.path ?? "/";
    const name = `${note.basename} (${t().pluginOutsideCopy(fileDate(new Date()))})`;
    return this.host.app.vault.create(
      this.freePath(folder === "/" ? "" : folder, name),
      text,
    );
  }

  /** `folder/name.md`, or `name 2.md`… if it exists. */
  freePath(folder: string, name: string): string {
    const path = (suffix: string) =>
      normalizePath(
        folder ? `${folder}/${name}${suffix}.md` : `${name}${suffix}.md`,
      );
    let candidate = path("");
    for (let n = 2; this.host.app.vault.getAbstractFileByPath(candidate); n++) {
      candidate = path(` ${n}`);
    }
    return candidate;
  }

  async isLinked(file: TFile): Promise<boolean> {
    // However another tool rewrote its header.
    const { document } = readLooseHeader(
      await this.host.app.vault.cachedRead(file),
    );
    return document !== undefined;
  }

  /** The note linked to `documentId` in this vault, if any. */
  noteOf(documentId: string): Promise<TFile | undefined> {
    return this.host.index.noteOf(documentId);
  }

  /** Without the system's keyring, `app.secretStorage` keeps the links
   * unencrypted; said once (Obsidian 1.11.4 has the method, its types don't).
   */
  sayIfNoKeyring(): void {
    const { storage } = this.host;
    const secrets = this.host.app.secretStorage as unknown as {
      isEncryptionAvailable?: () => boolean;
    };
    if (secrets.isEncryptionAvailable?.() !== false) return;
    if (storage.setting("toldNoKeyring") === true) return;
    storage.setSetting("toldNoKeyring", true);
    new Notice(t().pluginNoKeyring);
  }

  /** `openLink`, a failure said. */
  openPasted(text: string): Promise<void> {
    return this.openLink(text).catch((error: unknown) => {
      new Notice(
        t().pluginOpenFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  }

  /** Opens a pasted link's document: its note, or a new one in the plugin's
   * folder. */
  private async openLink(text: string): Promise<void> {
    const { app, links, views, settings } = this.host;
    const parsed = parseDocumentLink(text);
    if (!parsed.ok) {
      new Notice(
        parsed.problem === "insecure"
          ? t().pluginInsecureLink
          : parsed.problem === "invalid"
            ? t().invalidLink
            : t().pluginNotALink,
      );
      return;
    }
    const { documentId } = parsed.link;
    links.set(documentId, text.trim());
    this.sayIfNoKeyring();
    let note = await this.noteOf(documentId);
    if (!note) {
      const folder = normalizePath(settings.folder());
      if (folder !== "/" && !app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder);
      }
      // The export of the empty document: its first version.
      note = await app.vault.create(
        this.freePath(folder === "/" ? "" : folder, t().pluginViewTitle),
        writeHeader("", { document: documentId, version: "" }),
      );
      this.unnamed.add(note);
    }
    const live = views.live(documentId);
    if (live) {
      app.workspace.setActiveLeaf(live.leaf, { focus: true });
      return;
    }
    await app.workspace.getLeaf("tab").setViewState({
      type: "markdown",
      state: { file: note.path },
      active: true,
    });
  }
}
