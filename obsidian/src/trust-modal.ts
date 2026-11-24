import { type App, Modal } from "obsidian";
import { type PageConfig, t } from "../../web/src/embed.js";

/** What the server names, shown before it is trusted (M3): whoever chooses the
 * fingerprints chooses whose names read verified. */
export class TrustModal extends Modal {
  constructor(
    app: App,
    private readonly config: PageConfig,
    /** Once closed: `true` if « Use them » closed it. */
    private readonly onAnswer: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  private confirmed = false;

  override onOpen(): void {
    const doc = this.contentEl.ownerDocument;
    this.titleEl.textContent = t().pluginTrustTitle;
    const paragraph = (text: string) => {
      const element = doc.createElement("p");
      element.textContent = text;
      return element;
    };
    const keys = doc.createElement("ul");
    for (const key of this.config.attestationKeys ?? []) {
      const item = doc.createElement("li");
      const code = doc.createElement("code");
      code.textContent = key;
      item.append(code);
      keys.append(item);
    }
    const use = doc.createElement("button");
    use.className = "mod-cta";
    use.textContent = t().pluginTrustConfirm;
    use.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
    const cancel = doc.createElement("button");
    cancel.textContent = t().pluginCancel;
    cancel.addEventListener("click", () => this.close());
    const row = doc.createElement("div");
    row.className = "modal-button-container";
    row.append(cancel, use);
    this.contentEl.append(
      paragraph(
        this.config.gateway
          ? t().pluginTrustGateway(this.config.gateway)
          : t().pluginTrustNoGateway,
      ),
      paragraph(t().pluginTrustKeys),
      keys,
      paragraph(t().pluginTrustCompare),
      row,
    );
    cancel.focus();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
    this.onAnswer(this.confirmed);
  }
}
