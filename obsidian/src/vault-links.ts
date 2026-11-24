// How a note's `[[…]]` resolve, and how a document is named back
// (docs/phase-19-liens.md, decisions 3 and 9), from Obsidian's metadataCache: a
// linked note's header names its document, the link store its server; a note
// unlinked here, the plugin remembers. Synchronous: a keystroke's conversion
// can't wait.
import type { App, TFile } from "obsidian";
import type { LinkStore } from "./link-store.js";
import type { Resolve } from "./wikilinks.js";

/** The document a note's header names, as the metadataCache reads it. */
function documentOf(app: App, file: TFile): string | undefined {
  const id =
    app.metadataCache.getFileCache(file)?.frontmatter?.["collab-document"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** How `note`'s `[[…]]` resolve: a linked note whose link is kept here,
 * its document and its server's page; `note` itself; else none. */
export function vaultResolver(
  app: App,
  note: TFile,
  links: LinkStore,
): Resolve {
  return (linkpath) => {
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
    if (!dest) return undefined;
    if (dest.path === note.path) return "self";
    const documentId = documentOf(app, dest);
    const link = documentId && links.get(documentId);
    return link
      ? { documentId: documentId, base: new URL("/", link.apiBase).href }
      : undefined;
  };
}

/** Where `setting`s are kept: the plugin's `data.json`. */
interface Settings {
  setting(name: string): unknown;
  setSetting(name: string, value: unknown): void;
}

/** The notes unlinked in this vault, by document: unlinking in any order finds
 * the others, and a click on an address opens the note rather than a second
 * copy. The document's id isn't a secret. */
export class UnlinkedNotes {
  constructor(private readonly settings: Settings) {}

  private all(): Record<string, string> {
    const kept = this.settings.setting("unlinked");
    return typeof kept === "object" && kept !== null && !Array.isArray(kept)
      ? (kept as Record<string, string>)
      : {};
  }

  pathOf(documentId: string): string | undefined {
    const path = this.all()[documentId];
    return typeof path === "string" ? path : undefined;
  }

  note(documentId: string, path: string): void {
    this.settings.setSetting("unlinked", { ...this.all(), [documentId]: path });
  }

  /** Linked again: no longer one of these. */
  forget(documentId: string): void {
    const { [documentId]: _gone, ...rest } = this.all();
    this.settings.setSetting("unlinked", rest);
  }

  renamed(from: string, to: string): void {
    const all = this.all();
    const moved = Object.entries(all).map(([id, path]) => [
      id,
      path === from ? to : path,
    ]);
    if (moved.some(([, path], i) => path !== Object.values(all)[i]))
      this.settings.setSetting("unlinked", Object.fromEntries(moved));
  }

  deleted(path: string): void {
    const all = this.all();
    const kept = Object.entries(all).filter(([, at]) => at !== path);
    if (kept.length !== Object.keys(all).length)
      this.settings.setSetting("unlinked", Object.fromEntries(kept));
  }
}

/** How a document is named from `note`: its linked note's link text, else
 * that of a note unlinked here; none if neither is in the vault. */
export function vaultNames(
  app: App,
  note: TFile,
  unlinked: UnlinkedNotes,
): (documentId: string) => string | undefined {
  return (documentId) => {
    const linked = app.vault
      .getMarkdownFiles()
      .find((file) => documentOf(app, file) === documentId);
    const path = unlinked.pathOf(documentId);
    const file =
      linked ??
      (path ? (app.vault.getAbstractFileByPath(path) as TFile | null) : null);
    if (!file || !("extension" in file)) return undefined;
    return app.metadataCache.fileToLinktext(file, note.path, true);
  };
}
