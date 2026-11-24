import { type App, Modal } from "obsidian";
import { t } from "../../web/src/embed.js";

/** Asks for a document's link: a field and a button, Enter as the button. */
export class OpenLinkModal extends Modal {
  constructor(
    app: App,
    private readonly onLink: (text: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const doc = this.contentEl.ownerDocument;
    this.titleEl.textContent = t().pluginLinkTitle;
    const input = doc.createElement("input");
    input.type = "url";
    input.className = "collab-link-link";
    input.setAttribute("aria-label", t().pluginLinkLabel);
    input.style.width = "100%";
    const open = doc.createElement("button");
    open.className = "mod-cta";
    open.textContent = t().pluginOpen;
    const submit = () => {
      const text = input.value;
      this.close();
      this.onLink(text);
    };
    open.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    const row = doc.createElement("div");
    row.className = "modal-button-container";
    row.append(open);
    this.contentEl.append(input, row);
    input.focus();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }
}
