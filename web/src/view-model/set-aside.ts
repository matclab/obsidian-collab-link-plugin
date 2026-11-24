/** What I set aside (ADR-0050 §4): an annotation's id → the id of its last
 * entry when I did. Kept in the page's local record (ADR-0022), never in
 * the document. */
import type { SetAsideSource } from "./awaiting-index.js";

export class SetAside implements SetAsideSource {
  version = 0;
  private readonly entries: Map<string, string>;
  private readonly listeners = new Set<() => void>();

  constructor(stored: readonly (readonly [string, string])[] = []) {
    this.entries = new Map(stored);
  }

  get(annotationId: string): string | undefined {
    return this.entries.get(annotationId);
  }

  /** Sets `annotationId` aside until an entry follows `lastEntry`. */
  set(annotationId: string, lastEntry: string): void {
    if (this.entries.get(annotationId) === lastEntry) return;
    this.entries.set(annotationId, lastEntry);
    this.changed();
  }

  /** Puts it back. */
  clear(annotationId: string): void {
    if (this.entries.delete(annotationId)) this.changed();
  }

  /** What the record keeps: the entries of the annotations `keep` says. */
  stored(keep: (annotationId: string) => boolean): [string, string][] {
    return [...this.entries].filter(([id]) => keep(id));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}
