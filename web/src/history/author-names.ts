import type { LoroDoc } from "loro-crdt";
import { authors } from "./authorship.js";

/** The names the text is shown under (ADR-0059 §2), in the shape of
 * `AnnotationIndex`: `current()` is `authors()`, read again only after a
 * change of the peers table or of the annotations (a suggestion's author);
 * subscribers are told at most once per `schedule` (a microtask) when it
 * may have changed. `AnnotationIndex` itself says nothing of the peers
 * table. */
export class AuthorNames {
  private names: ReadonlyMap<string, string> | undefined;
  private scheduled = false;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly annotationsDoc: LoroDoc,
    // Called alone: a browser refuses `queueMicrotask` as a method.
    private readonly schedule: (run: () => void) => void = (run) =>
      queueMicrotask(run),
  ) {
    this.unsubscribe = annotationsDoc.subscribe((batch) => {
      const touched = batch.events.some(
        ({ path: [root] }) => root === "peers" || root === "annotations",
      );
      if (!touched) return;
      this.names = undefined;
      if (this.scheduled) return;
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        for (const listener of [...this.listeners]) listener();
      });
    });
  }

  current(): ReadonlyMap<string, string> {
    this.names ??= authors(this.annotationsDoc);
    return this.names;
  }

  /** Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
