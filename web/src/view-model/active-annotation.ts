/** Where the active annotation was chosen: a card, a mark in the text, the
 * review's walk. Each side follows the others, not itself. */
export type ActiveOrigin = "card" | "mark" | "review";

/** The annotation in focus, shared by the cards, the editor's
 * marks and the review: chosen on one side, shown on the others. */
export class ActiveAnnotation {
  private current: string | undefined;
  private readonly listeners = new Set<
    (id: string | undefined, origin: ActiveOrigin) => void
  >();
  private readonly againListeners = new Set<
    (id: string, origin: ActiveOrigin) => void
  >();

  get id(): string | undefined {
    return this.current;
  }

  set(id: string | undefined, origin: ActiveOrigin): void {
    if (id === this.current) {
      if (id !== undefined)
        for (const listener of this.againListeners) listener(id, origin);
      return;
    }
    this.current = id;
    for (const listener of this.listeners) listener(id, origin);
  }

  subscribe(
    listener: (id: string | undefined, origin: ActiveOrigin) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Told when the active one is chosen again: nothing changes, but its
   * passage, maybe scrolled away, is wanted back (the one card left in
   * Review: ‹ › and a click on it choose it again). */
  subscribeAgain(
    listener: (id: string, origin: ActiveOrigin) => void,
  ): () => void {
    this.againListeners.add(listener);
    return () => this.againListeners.delete(listener);
  }
}
