import { ItemView, type WorkspaceLeaf } from "obsidian";
import { type HomeView, t } from "../../web/src/embed.js";

/** The type of « Mes documents », in Obsidian's workspace. */
export const MY_DOCUMENTS_VIEW = "collab-link-my-documents";

/** What the view needs of the plugin: the page's home, mounted for the vault
 * (M5), or why there is none. */
export interface MyDocumentsHost {
  mountHome(root: HTMLElement): Promise<HomeView | string>;
}

/** « Mes documents » of the vault: the page's home, in a tab. */
export class MyDocumentsView extends ItemView {
  private home: HomeView | undefined;
  private shown: Promise<void> = Promise.resolve();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: MyDocumentsHost,
  ) {
    super(leaf);
    // What its styles are under.
    this.contentEl.classList.add("collab-link-view");
  }

  getViewType(): string {
    return MY_DOCUMENTS_VIEW;
  }

  getDisplayText(): string {
    return t().myDocuments;
  }

  override getIcon(): string {
    return "library";
  }

  /** Resolves once the list stored on this device, if any, is shown. */
  async ready(): Promise<void> {
    await this.shown;
    await this.home?.ready;
  }

  protected override async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();
    const root = this.contentEl.ownerDocument.createElement("div");
    this.contentEl.append(root);
    this.shown = this.host.mountHome(root).then((home) => {
      if (typeof home === "string") {
        const said = this.contentEl.ownerDocument.createElement("p");
        said.className = "collab-link-message";
        said.textContent = home;
        root.replaceWith(said);
        return;
      }
      if (this.closed) home.close();
      else this.home = home;
    });
  }

  private closed = false;

  protected override async onClose(): Promise<void> {
    this.closed = true;
    await this.shown;
    this.home?.close();
    this.home = undefined;
  }
}
