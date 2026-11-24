import { type App, Modal } from "obsidian";
import { t } from "../../web/src/embed.js";

/** Asks before sharing: what the note becomes, and that all of it, its
 * properties included, goes to the link's holders. */
export class ShareModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const doc = this.contentEl.ownerDocument;
    this.titleEl.textContent = t().pluginShareTitle;
    const paragraph = (text: string) => {
      const element = doc.createElement("p");
      element.textContent = text;
      return element;
    };
    const share = doc.createElement("button");
    share.className = "mod-cta";
    share.textContent = t().pluginShareConfirm;
    share.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    const cancel = doc.createElement("button");
    cancel.textContent = t().pluginCancel;
    cancel.addEventListener("click", () => this.close());
    const row = doc.createElement("div");
    row.className = "modal-button-container";
    row.append(cancel, share);
    this.contentEl.append(
      paragraph(t().pluginShareProperties),
      paragraph(t().pluginShareChange),
      row,
    );
    share.focus();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }
}
