/** Work counters for the performance budgets (docs/phase-4ter-*.md,
 * decision 1): deterministic, unlike timings, so `npm test` can assert on
 * them. Plain integer increments, always on — they never change behavior,
 * and cost nothing next to the work they count. */

export type CounterName =
  /** One `getCursorPos` call: the unit cost of resolving annotations. */
  | "cursor.resolve"
  /** One reading of the formatting toolbar's state. */
  | "toolbar.state"
  /** One / typed where the / menu may open, looked at in the parse
   *: never for another keystroke (WA6). */
  | "slash.open"
  /** One # typed where a link's menu may open, right after `](` or `[[`,
   * looked at in the parse: never for another
   * keystroke. */
  | "anchor.open"
  /** One move of the caret looked at for a first hint (ADR-0064, AC7):
   * never for a keystroke, nor once both are seen. */
  | "hints.check"
  /** One line of the selection looked at by a formatting construct
   *: what a reading of the toolbar's state costs. */
  | "format.line"
  /** One cursor resolved by walking the history: its character was
   * deleted (E3). Each is paid once, then by its update. */
  | "cursor.slow"
  /** One full resolution of every annotation (the shared index, or a
   * direct `listAnnotations`). */
  | "annotations.resolveAll"
  /** One rebuild of the annotations panel's list. */
  | "panel.render"
  /** One rebuild of the editor's annotation decorations. */
  | "decorations.build"
  /** One `doc.import`/`doc.importBatch` call on a Loro channel. */
  | "loro.import"
  /** One entry sent on a Loro channel (a journal entry, once acked). */
  | "publish.frame"
  /** One adopted change sent on its own (R-A1). */
  | "publish.adopted"
  /** One entry skipped: it doesn't decrypt, or isn't a Loro update
   * (docs/phase-5-modele-acces.md, decision 10). */
  | "import.invalid"
  /** One detached change decoded on a fork of the content doc: the unit
   * cost of checking a suggestion (ADR-0018). */
  | "detached.check"
  /** One Markdown rendering of the whole text by the preview (ADR-0021). */
  | "preview.render"
  /** One parse of the text for its remote images, for the banner
   * (ADR-0055 §4): never for a text without both `![` and `https:`. */
  | "images.scan"
  // An attached image's slot filled (ADR-0057 §8).
  | "preview.attached-image"
  /** One annotation's text — a body, a note, a reply — rendered as
   * Markdown for its card (ADR-0047 §9). */
  | "annotation.text.render"
  /** One computation of what awaits my reply (ADR-0050 §7): never for a
   * keystroke, once per change of a thread, a verdict, my keys, a
   * decision or a setting aside. */
  | "awaiting.compute"
  /** One thread read by that computation. */
  | "awaiting.thread"
  /** One reading of what awaits my reply, for the alerts (ADR-0060 §1):
   * once per notification of the index, never for a keystroke. */
  | "alerts.observe"
  /** One thread read by it. */
  | "alerts.thread"
  /** One formula typeset by KaTeX (a cached one costs none). */
  | "katex.render"
  /** One diagram drawn by Pele (a cached one costs none). */
  | "diagram.render"
  /** One local record captured: both snapshots exported (ADR-0022). */
  | "storage.capture"
  /** One computation of the history's list of versions. */
  | "history.list"
  /** One fork of the content doc to read a past version. */
  | "history.fork"
  /** One search of the document's title for the header. */
  | "title.compute"
  /** One placement of the cards in the margin. */
  | "margin.layout"
  /** One export of a linked note written by the plugin. */
  | "export.write"
  /** One fork of the content doc to read the text an annotation covered
   * (ADR-0052, TA4): never but on a click or an export. */
  | "annotations.textThen"
  /** One fork of the content doc to check a note's exported version
   * (NE4). */
  | "export.fork"
  /** One marking of the annotations in the preview. */
  | "preview.marks"
  /** One presence state sent (ADR-0025). */
  | "presence.publish"
  /** One resolution of the others' cursors for the editor (ADR-0025). */
  | "presence.resolve"
  /** One computation of the formatted text's decorations. */
  | "live.build"
  /** One syntax node looked at by that computation: its unit cost. */
  | "live.node"
  /** One computation of the formatted text's block widgets. */
  | "live.blocks"
  /** One top-level block looked at by that computation: its unit cost. */
  | "live.block"
  /** One range another layer keeps in sight, read by the formatting
   *: an annotation's, a remote cursor's. */
  | "live.reveal"
  /** One alignment of a side-by-side column on the other. */
  | "sync.scroll"
  /** One parse of the text for the outline, whole or incremental
   *. */
  | "outline.parse"
  /** One top-level block looked at for the outline: its unit cost. */
  | "outline.block"
  /** One rendering of the outline's column. */
  | "outline.render"
  /** An Ed25519 verification of a signature. */
  | "identity.verify"
  /** An entry of `attestations` read (§6.10): once per key and bytes. */
  | "identity.attestation"
  /** The signature index read the document's signed objects again. */
  | "signatures.compute"
  /** One character's author read from Loro (ADR-0059 §1): never for a
   * keystroke while "who wrote" is off (AU3). */
  | "authorship.char"
  /** One reading of an insertion's date, for the legend (ADR-0059 §4). */
  | "authorship.date"
  /** One computation of the persons' order, for their colors (§3). */
  | "authorship.order"
  /** One rendering of the legend (§4): once per microtask at most, while
   * on. */
  | "authorship.legend"
  /** One drawing of the preview's bars (§6): after a rendering, or a
   * change of the marks without a change of the text. */
  | "authorship.bars";

const counts = new Map<CounterName, number>();

export function count(name: CounterName, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by);
}

export function counter(name: CounterName): number {
  return counts.get(name) ?? 0;
}

export function resetCounters(): void {
  counts.clear();
}

/** Every counter, for reports (`?perf`, the bench). */
export function counters(): Partial<Record<CounterName, number>> {
  return Object.fromEntries(counts);
}

/** Counts `name` while `run` runs: how many increments it caused. */
export function countDuring(name: CounterName, run: () => void): number {
  const before = counter(name);
  run();
  return counter(name) - before;
}
