import { type App, Notice, type TFile } from "obsidian";
import { t } from "../../web/src/embed.js";
import type { VaultNotes } from "./notes.js";
import type { PluginSettings } from "./plugin-settings.js";
import type { VaultKeyring } from "./vault-keyring.js";
import type { UnlinkedNotes } from "./vault-links.js";

/** What opening an address needs of the plugin. */
export interface AddressesHost {
  app: App;
  settings: PluginSettings;
  unlinked: UnlinkedNotes;
  notes: VaultNotes;
  keyring: VaultKeyring;
  track<T>(work: Promise<T>): Promise<T>;
}

/** An address of a document of this server, without its key
 * (ADR-0045): opened in its note here, not in the browser. */
export class Addresses {
  /** Addresses being opened, by document: a second click waits for the first.
   */
  private readonly opening = new Map<string, Promise<void>>();

  constructor(private readonly host: AddressesHost) {}

  /** An address of this server's document without its key: taken,
   * opened here; any other, left to `open`. */
  follow(href: string, open: typeof window.open): boolean {
    const server = this.host.settings.serverSet();
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    const documentId = url.searchParams.get("doc");
    if (!server || url.origin !== server || !documentId) return false;
    const fragment = new URLSearchParams(url.hash.slice(1));
    if ([...fragment.keys()].some((name) => name !== "h")) return false;
    const heading = fragment.get("h") || undefined;
    const running = this.opening.get(documentId);
    const next = (running ?? Promise.resolve())
      .then(() => this.open(documentId, heading, href, open))
      .finally(() => {
        if (this.opening.get(documentId) === next)
          this.opening.delete(documentId);
      });
    this.opening.set(documentId, next);
    void this.host.track(next);
    return true;
  }

  /** The note of `documentId`, linked or unlinked here, at `heading`; else
   * its link in « Mes documents », opened as « Ouvrir un document de Mes
   * documents » does; else said, with a way to the browser. */
  private async open(
    documentId: string,
    heading: string | undefined,
    href: string,
    open: typeof window.open,
  ): Promise<void> {
    const { app, settings, notes, keyring } = this.host;
    const unlinkedPath = this.host.unlinked.pathOf(documentId);
    const unlinked = unlinkedPath
      ? app.vault.getAbstractFileByPath(unlinkedPath)
      : null;
    let note =
      (await notes.noteOf(documentId)) ??
      (unlinked && "extension" in unlinked ? (unlinked as TFile) : undefined);
    if (!note) {
      // As « Ouvrir un document de Mes documents »: the vault's list,
      // kept meanwhile in another window perhaps.
      await keyring.ensure();
      const session =
        (await keyring.current()) ?? (await keyring.reopenSession());
      const entry = session
        ?.entries()
        .find(
          (e) =>
            e.documentId === documentId &&
            new URL(e.link).origin === settings.serverSet(),
        );
      if (!entry) {
        const fragment = document.createDocumentFragment();
        fragment.append(t().pluginAddressUnknown, " ");
        const button = fragment.appendChild(document.createElement("button"));
        button.textContent = t().pluginOpenInBrowser;
        button.addEventListener("click", () => void open.call(window, href));
        new Notice(fragment, 0);
        return;
      }
      await notes.openPasted(entry.link);
      note = await notes.noteOf(documentId);
      if (!note) return;
    }
    // As Obsidian opens a note (a linked one goes to the view), the
    // heading as its links give it.
    await app.workspace
      .getLeaf(false)
      .setViewState(
        { type: "markdown", state: { file: note.path }, active: true },
        heading ? { subpath: `#${heading}` } : undefined,
      );
  }
}
