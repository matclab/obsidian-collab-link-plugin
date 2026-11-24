import { type App, SuggestModal } from "obsidian";
import type { KeyringEntry } from "../../web/lib/src/index.js";
import { t } from "../../web/src/embed.js";

/** « Ouvrir un document de Mes documents » (M6): the vault's list, filtered by
 * title; the one chosen opens in its note. */
export class DocumentsModal extends SuggestModal<KeyringEntry> {
  constructor(
    app: App,
    private readonly entries: () => KeyringEntry[],
    private readonly onChoose: (entry: KeyringEntry) => void,
  ) {
    super(app);
    this.setPlaceholder(t().pluginOpenFromMyDocumentsPlaceholder);
  }

  getSuggestions(query: string): KeyringEntry[] {
    const asked = query.trim().toLocaleLowerCase();
    return this.entries()
      .filter((entry) => !entry.excluded && entry.state !== "deleted")
      .filter((entry) =>
        (entry.title ?? t().untitled).toLocaleLowerCase().includes(asked),
      );
  }

  renderSuggestion(entry: KeyringEntry, el: HTMLElement): void {
    el.textContent = entry.title ?? t().untitled;
  }

  onChooseSuggestion(entry: KeyringEntry): void {
    this.onChoose(entry);
  }
}
