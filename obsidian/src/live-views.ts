/** One live view per document (docs/phase-14-plugin-obsidian.md, decision 16):
 * the view that holds each, and the closing of the one before, which the next
 * waits for — its local lock let go. LV1–LV4
 * (docs/phase-39-refactorisation-du-plugin.md). */
export class LiveViews<View> {
  private readonly views = new Map<string, View>();
  /** Views closing, by document: their lock is free once done. */
  private readonly closing = new Map<string, Promise<void>>();

  /** `view` becomes the document's, unless another is; resolves once the
   * previous view of the document has let its local lock go. */
  async claim(documentId: string, view: View): Promise<boolean> {
    const live = this.views.get(documentId);
    if (live && live !== view) return false;
    this.views.set(documentId, view);
    await this.closing.get(documentId);
    return true;
  }

  /** The view of a document, while it is live. */
  live(documentId: string): View | undefined {
    return this.views.get(documentId);
  }

  /** The live views. */
  all(): IterableIterator<View> {
    return this.views.values();
  }

  /** `view` let the document go; `closed` resolves once its lock is
   * free. Awaited after the closings let go before it (LV2), whatever the
   * order they end in; a failure of theirs is theirs. */
  release(documentId: string, view: View, closed: Promise<void>): void {
    if (this.views.get(documentId) === view) this.views.delete(documentId);
    const before = this.closing.get(documentId);
    const after = before
      ? before.then(
          () => closed,
          () => closed,
        )
      : closed;
    const done = after.finally(() => {
      if (this.closing.get(documentId) === done) {
        this.closing.delete(documentId);
      }
    });
    this.closing.set(documentId, done);
  }

  /** How many documents have a closing awaited (tests: LV4). */
  closings(): number {
    return this.closing.size;
  }
}
