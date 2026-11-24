import { Facet, type RangeSet, type RangeValue } from "@codemirror/state";
import { count } from "../perf/index.js";

/** A range live formatting must not take out of sight: an
 * open annotation's passage or point (a proposal, a comment's marker), a
 * remote caret or selection — revealed when all of it would be hidden
 * —, the active annotation's passage, always
 * revealed (point 3). A table or formula block holding an annotation
 * stays its source (decision 7). */
export interface Reveal {
  from: number;
  to: number;
  kind: "annotation" | "active" | "cursor";
}

/** What a layer keeps in sight between two positions: looked up there
 * only, never over the whole document — a keystroke reads what is on
 * screen. */
export type RevealSource = (from: number, to: number) => readonly Reveal[];

/** What the editor's other layers keep in sight; each provides a source
 * computed from its own state field. */
export const liveReveal = Facet.define<RevealSource>();

/** A source over the ranges of `set`, each of the kind `kind` says. */
export function revealSource<T extends RangeValue>(
  set: RangeSet<T>,
  kind: (value: T) => Reveal["kind"],
): RevealSource {
  return (from, to) => {
    const found: Reveal[] = [];
    set.between(from, to, (start, end, value) => {
      found.push({ from: start, to: end, kind: kind(value) });
    });
    return found;
  };
}

/** What every source keeps in sight between `from` and `to`; each range
 * counted (`live.reveal`). */
export function revealsBetween(
  sources: readonly RevealSource[],
  from: number,
  to: number,
): Reveal[] {
  const found: Reveal[] = [];
  for (const source of sources) {
    for (const range of source(from, to)) {
      count("live.reveal");
      found.push(range);
    }
  }
  return found;
}
