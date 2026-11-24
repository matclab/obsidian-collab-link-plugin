import type { Cursor, LoroDoc, LoroEvent, VersionVector } from "loro-crdt";
import { HISTORY_ROOTS } from "../history/tables.js";
import { IDENTITIES } from "../identity/signature.js";
import { EDITOR_ORIGIN } from "../origins.js";
import { count } from "../perf/index.js";
import { isWasmTrap } from "../transport/fatal.js";
import type { DecisionLog } from "./decisions.js";
import { type DetachedPreview, previewDetachedChange } from "./detached.js";
import { type Annotation, listAnnotations } from "./model.js";
import { type ConflictPair, findCrossingConflicts } from "./overlap.js";

/** Everything derived from the two docs that the page shows. */
export interface AnnotationsView {
  /** Every annotation, resolved, in creation order (the panel's order). */
  annotations: readonly Annotation[];
  byId: ReadonlyMap<string, Annotation>;
  /** Crossings among open annotations (ADR-0012, layer 2). */
  conflicts: readonly ConflictPair[];
  /** For each open addition or substitution: its proposed text and where
   * it would land, decoded from its change (ADR-0018) — it is not in
   * `content`. */
  previews: ReadonlyMap<string, DetachedPreview>;
}

/** Decoded previews, kept across versions: a change's verdict and text
 * never change, so it is decoded once (a fork, an import); where it lands
 * is then followed by a Loro cursor on the character after it, resolved
 * like an anchor. Display only: text typed exactly there afterwards may
 * show on the other side of the widget than the import will put it (the
 * import itself is always exact). A pending change is decoded again, until
 * its dependencies arrive. */
export class PreviewCache {
  private entries = new Map<
    string,
    { change: Uint8Array; preview: DetachedPreview; cursor?: Cursor }
  >();

  previews(
    contentDoc: LoroDoc,
    annotations: readonly Annotation[],
  ): Map<string, DetachedPreview> {
    const previews = new Map<string, DetachedPreview>();
    const kept = new Map<
      string,
      { change: Uint8Array; preview: DetachedPreview; cursor?: Cursor }
    >();
    for (const a of annotations) {
      if (a.status !== "open" || !a.change) continue;
      const cached = this.entries.get(a.id);
      const entry =
        cached && sameBytes(cached.change, a.change)
          ? cached
          : { change: a.change, preview: { kind: "pending" as const } };
      let preview = followed(contentDoc, entry);
      if (!preview) {
        preview = previewDetachedChange(contentDoc, a.id, a.change);
        entry.preview = preview;
        entry.cursor =
          preview.kind === "valid"
            ? contentDoc.getText("content").getCursor(preview.at, 0)
            : undefined;
      }
      kept.set(a.id, entry);
      previews.set(a.id, preview);
    }
    this.entries = kept;
    return previews;
  }
}

/** A cached preview still good now, or `undefined` to decode again. */
function followed(
  contentDoc: LoroDoc,
  entry: { preview: DetachedPreview; cursor?: Cursor },
): DetachedPreview | undefined {
  const { preview, cursor } = entry;
  if (preview.kind === "invalid") return preview;
  if (preview.kind !== "valid" || !cursor) return undefined;
  count("cursor.resolve");
  const at = contentDoc.getCursorPos(cursor)?.offset;
  return at === undefined ? undefined : { ...preview, at };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A fresh computation of the view: what `AnnotationIndex.current()` must
 * always equal (its previews may follow the text, see `PreviewCache`). */
export function computeAnnotationsView(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  cache: PreviewCache = new PreviewCache(),
  /** Fast ranges, for what is shown (E3); `false` for what
   * writes from them (the export). */
  forDisplay = true,
): AnnotationsView {
  // Closed annotations unresolved: nothing here reads their range, and it
  // may cost a walk of the history (E4).
  const listed = listAnnotations(contentDoc, annotationsDoc, {
    closedRanges: false,
    forDisplay,
  });
  const previews = cache.previews(contentDoc, listed);
  return {
    annotations: [...listed].sort((a, b) => a.createdAt - b.createdAt),
    byId: new Map(listed.map((a) => [a.id, a])),
    conflicts: findCrossingConflicts(listed.filter((a) => a.status === "open")),
    previews,
  };
}

/** The shared derived model of a client's annotations
 * (docs/phase-4ter-*.md, decision 2). Before it, every consumer —
 * decorations, panel, conflicts, decision effects — listened to Loro on
 * its own and resolved every annotation on every event, several times per
 * import.
 *
 * - `current()` is always fresh: it is cached per version of the two docs,
 *   so it resolves the annotations at most once per version, however many
 *   readers ask, and never returns a stale view.
 * - Subscribers are notified at most once per microtask, after any change
 *   they must show: a change to the annotations doc (local or imported),
 *   any change of the content doc but the editor's own typing (an
 *   import, a decision's effect, a restore — phase 7b: a local writer of
 *   the text that writes no annotation), a confirmed decision. Typing
 *   costs no resolution: the editor maps its decorations itself.
 * - Writers (decision effects) run first in a notification, then readers,
 *   so that readers render the effects they applied, once. */
function inHistoryTables(event: LoroEvent): boolean {
  const [root] = event.path;
  return (
    typeof root === "string" &&
    (HISTORY_ROOTS.includes(root) || root === IDENTITIES)
  );
}

export class AnnotationIndex {
  private cache:
    | {
        content: VersionVector;
        annotations: VersionVector;
        view: AnnotationsView;
      }
    | undefined;
  private readonly previewCache = new PreviewCache();
  private readonly readers = new Set<() => void>();
  private readonly writers = new Set<() => void>();
  private scheduled = false;
  private changed = false;
  private readonly unsubscribes: (() => void)[];

  constructor(
    readonly contentDoc: LoroDoc,
    readonly annotationsDoc: LoroDoc,
    log?: Pick<DecisionLog, "subscribe">,
    private readonly options: {
      /** A Loro panic raised by a listener (R3): the page halts
       * (phase 9, L4). Without it, rethrown. */
      onTrap?: (error: unknown) => void;
    } = {},
  ) {
    const changed = () => {
      this.changed = true;
      this.schedule();
    };
    this.unsubscribes = [
      annotationsDoc.subscribe((batch) => {
        // The history's tables share the doc: naming a version
        // or registering a peer resolves no annotation.
        if (!batch.events.every(inHistoryTables)) changed();
      }),
      contentDoc.subscribe((batch) => {
        // The editor's own typing: its decorations map through it.
        if (batch.by === "local" && batch.origin === EDITOR_ORIGIN) return;
        changed();
      }),
      ...(log ? [log.subscribe(changed)] : []),
    ];
  }

  current(): AnnotationsView {
    const content = this.contentDoc.version();
    const annotations = this.annotationsDoc.version();
    const cache = this.cache;
    if (
      cache &&
      cache.content.compare(content) === 0 &&
      cache.annotations.compare(annotations) === 0
    ) {
      return cache.view;
    }
    const view = computeAnnotationsView(
      this.contentDoc,
      this.annotationsDoc,
      this.previewCache,
    );
    this.cache = { content, annotations, view };
    return view;
  }

  /** A reader: renders `current()`. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.readers.add(listener);
    return () => this.readers.delete(listener);
  }

  /** A writer: may change the docs; runs before the readers. */
  subscribeWriter(listener: () => void): () => void {
    this.writers.add(listener);
    return () => this.writers.delete(listener);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.readers.clear();
    this.writers.clear();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  // Outside Loro's event dispatch, where writing to a doc is safe. What the
  // writers commit schedules one more flush: they run again (idempotent),
  // the readers don't, having already seen it.
  private flush(): void {
    this.scheduled = false;
    const { onTrap } = this.options;
    for (const writer of [...this.writers]) run(writer, onTrap);
    if (!this.changed) return;
    this.changed = false;
    for (const reader of [...this.readers]) run(reader, onTrap);
  }
}

// One failing listener must not starve the others; the error still
// surfaces (the simulation and `?trace` capture console.error). Not a Loro
// panic: the document is poisoned, the page must halt (R3).
function run(
  listener: () => void,
  onTrap: ((error: unknown) => void) | undefined,
): void {
  try {
    listener();
  } catch (error) {
    if (!isWasmTrap(error)) {
      console.error(error);
    } else if (onTrap) {
      onTrap(error);
    } else {
      throw error;
    }
  }
}
