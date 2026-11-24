import {
  type ChangeDesc,
  Compartment,
  type EditorState,
  Facet,
  type Range,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { LoroDoc } from "loro-crdt";
import type { AuthorNames } from "../history/author-names.js";
import { authorRuns, personOf, personOrder } from "../history/authorship.js";

/** Who wrote, in the editor (ADR-0059 §5): each character's background by
 * its person. A character's author never changes, so each is read from
 * Loro once: the page's own typing is its own peer's, marked
 * at once without a reading; another's text, arrived through the link to
 * Loro, stays unmarked until read; the shown text not yet read is read in
 * one go, later (`schedule`: a microtask), when the editor and Loro hold
 * the same text — after every synchronous step (`createDocumentEditor`).
 * Off, nothing is read. */

/** The colors (ADR-0059 §3); a ninth person takes the first again. */
const COLORS = 8;
const UNKNOWN_CLASS = "cm-author-unknown";

/** `[from, to)` ranges of the text, sorted, apart. */
type Spans = readonly { from: number; to: number }[];

interface Marks {
  set: DecorationSet;
  /** What the marks tell: read, or typed here. */
  covered: Spans;
  /** Each peer's class, by its person's place (`personOrder`). */
  classOf: ReadonlyMap<string, string>;
  /** Typed here by a peer `classOf` didn't know: to color again. */
  stale: boolean;
}

/** The page's own peer, as it writes to Loro now. */
const ownPeer = Facet.define<() => string, () => string>({
  combine: (values) => values[0] ?? (() => ""),
});

const read = StateEffect.define<{ add: Range<Decoration>[]; spans: Spans }>();
const recolor = StateEffect.define<ReadonlyMap<string, string>>();

function mark(peer: string | undefined, className: string): Decoration {
  return Decoration.mark({ class: `cm-author ${className}`, peer });
}

const EMPTY: Marks = {
  set: Decoration.none,
  covered: [],
  classOf: new Map(),
  stale: false,
};

const field = StateField.define<Marks>({
  create: () => EMPTY,
  update(marks, tr) {
    let { set, covered, classOf, stale } = marks;
    if (tr.docChanged) {
      set = set.map(tr.changes);
      covered = mapSpans(covered, tr.changes);
      // Not through the link to Loro: typed here, by the page's peer.
      const own = tr.annotation(Transaction.remote)
        ? undefined
        : tr.state.facet(ownPeer)();
      tr.changes.iterChangedRanges((_fromA, _toA, from, to) => {
        if (to <= from) return;
        set = cut(set, from, to);
        covered = subtract(covered, from, to);
        if (own === undefined) return;
        const className = classOf.get(own);
        if (className === undefined) stale = true;
        set = set.update({
          add: [mark(own, className ?? UNKNOWN_CLASS).range(from, to)],
        });
        covered = union(covered, [{ from, to }]);
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(read)) {
        set = set.update({ add: effect.value.add, sort: true });
        covered = union(covered, effect.value.spans);
      } else if (effect.is(recolor)) {
        classOf = effect.value;
        stale = false;
        const add: Range<Decoration>[] = [];
        set.between(0, tr.state.doc.length, (from, to, value) => {
          const peer = value.spec.peer as string | undefined;
          add.push(
            mark(peer, (peer && classOf.get(peer)) || UNKNOWN_CLASS).range(
              from,
              to,
            ),
          );
        });
        set = Decoration.set(add);
      }
    }
    return { set, covered, classOf, stale };
  },
  provide: (self) => EditorView.decorations.from(self, (marks) => marks.set),
});

/** The marks of `state` over `[from, to)` (default: all): their range,
 * classes and peer. */
export function authorMarks(
  state: EditorState,
  from = 0,
  to = state.doc.length,
): { from: number; to: number; className: string; peer: string | undefined }[] {
  const marks = state.field(field, false);
  if (!marks) return [];
  const found: ReturnType<typeof authorMarks> = [];
  marks.set.between(from, to, (start, end, value) => {
    if (end <= from || start >= to) return;
    found.push({
      from: start,
      to: end,
      className: value.spec.class as string,
      peer: value.spec.peer as string | undefined,
    });
  });
  return found;
}

/** The mark over the character at `pos`, if read. */
export function authorMarkAt(
  state: EditorState,
  pos: number,
): ReturnType<typeof authorMarks>[number] | undefined {
  const marks = state.field(field, false);
  let found: ReturnType<typeof authorMarks>[number] | undefined;
  marks?.set.between(pos, pos + 1, (from, to, value) => {
    if (from > pos || to <= pos) return;
    found = {
      from,
      to,
      className: value.spec.class as string,
      peer: value.spec.peer as string | undefined,
    };
    return false;
  });
  return found;
}

export interface Authorship {
  on(): boolean;
  /** Shows who wrote, or stops: on, the marks are built anew. */
  setOn(on: boolean): void;
  /** Reads the whole text, not only what the editor shows: for the
   * preview's bars (ADR-0059 §6), once; then, as ever, only what arrives. */
  setWhole(whole: boolean): void;
  destroy(): void;
}

/** Shows who wrote in `view`, the editor of `contentDoc`'s text, by
 * `names`; off until `setOn(true)`. */
export function attachAuthorship(
  view: EditorView,
  contentDoc: LoroDoc,
  names: Pick<AuthorNames, "current" | "subscribe">,
  options: {
    schedule?: (run: () => void) => void;
    /** Told of every update of the editor while on, the marks' too: the
     * legend follows them. */
    onUpdate?: (update: ViewUpdate) => void;
  } = {},
): Authorship {
  const schedule = options.schedule ?? ((run) => queueMicrotask(run));
  const text = contentDoc.getText("content");
  const slot = new Compartment();
  let on = false;
  let stopped = false;
  let pending = false;
  let whole = false;
  let unsubscribe: (() => void) | undefined;

  // The shown text not yet read, and every peer's class.
  const refresh = () => {
    pending = false;
    if (!on || stopped) return;
    const marks = view.state.field(field);
    const known = names.current();
    const order = personOrder(contentDoc, known);
    const classOf = new Map<string, string>();
    for (const peer of contentDoc.oplogVersion().toJSON().keys()) {
      const place = order.indexOf(personOf(peer, known).key);
      classOf.set(
        peer,
        place < 0 ? UNKNOWN_CLASS : `cm-author-${(place % COLORS) + 1}`,
      );
    }
    const spans: { from: number; to: number }[] = [];
    const wanted = whole
      ? [{ from: 0, to: view.state.doc.length }]
      : view.visibleRanges;
    for (const shown of wanted) {
      spans.push(...subtractAll(shown, marks.covered));
    }
    const add: Range<Decoration>[] = [];
    for (const span of spans) {
      for (const run of authorRuns(text, span.from, span.to)) {
        const className = (run.peer && classOf.get(run.peer)) || UNKNOWN_CLASS;
        add.push(mark(run.peer, className).range(run.from, run.to));
      }
    }
    const effects: StateEffect<unknown>[] = [];
    if (add.length > 0) effects.push(read.of({ add, spans }));
    if (marks.stale || !sameClasses(marks.classOf, classOf)) {
      effects.push(recolor.of(classOf));
    }
    if (effects.length > 0) view.dispatch({ effects });
  };
  const later = () => {
    if (pending) return;
    pending = true;
    schedule(refresh);
  };

  const plugin = ViewPlugin.define(() => {
    later();
    return {
      update(update) {
        const arrived = update.transactions.some(
          (tr) => tr.docChanged && tr.annotation(Transaction.remote),
        );
        if (
          arrived ||
          update.viewportChanged ||
          update.state.field(field).stale
        ) {
          later();
        }
        options.onUpdate?.(update);
      },
    };
  });

  view.dispatch({ effects: StateEffect.appendConfig.of(slot.of([])) });
  return {
    on: () => on,
    setWhole(next) {
      if (next === whole) return;
      whole = next;
      if (whole && on) later();
    },
    setOn(next) {
      if (stopped || next === on) return;
      on = next;
      unsubscribe?.();
      unsubscribe = on ? names.subscribe(later) : undefined;
      view.dispatch({
        effects: slot.reconfigure(
          on ? [field, plugin, ownPeer.of(() => contentDoc.peerIdStr)] : [],
        ),
      });
    },
    destroy() {
      stopped = true;
      unsubscribe?.();
    },
  };
}

function sameClasses(
  x: ReadonlyMap<string, string>,
  y: ReadonlyMap<string, string>,
): boolean {
  if (x.size !== y.size) return false;
  for (const [peer, className] of x) {
    if (y.get(peer) !== className) return false;
  }
  return true;
}

/** The marks over `[from, to)` taken away; their parts outside kept. */
function cut(set: DecorationSet, from: number, to: number): DecorationSet {
  const add: Range<Decoration>[] = [];
  set.between(from, to, (start, end, value) => {
    if (end <= from || start >= to) return; // touches only: kept
    if (start < from) add.push(value.range(start, from));
    if (end > to) add.push(value.range(to, end));
  });
  return set.update({
    filter: (start, end) => end <= from || start >= to,
    filterFrom: from,
    filterTo: to,
    add,
    sort: true,
  });
}

/** Through `changes`: a span keeps what it covered, never more. */
function mapSpans(spans: Spans, changes: ChangeDesc): Spans {
  const mapped: { from: number; to: number }[] = [];
  for (const { from, to } of spans) {
    const start = changes.mapPos(from, 1);
    const end = changes.mapPos(to, -1);
    if (end > start) mapped.push({ from: start, to: end });
  }
  return mapped;
}

function subtract(spans: Spans, from: number, to: number): Spans {
  const left: { from: number; to: number }[] = [];
  for (const span of spans) {
    if (span.to <= from || span.from >= to) left.push(span);
    else {
      if (span.from < from) left.push({ from: span.from, to: from });
      if (span.to > to) left.push({ from: to, to: span.to });
    }
  }
  return left;
}

/** What of `shown` `covered` doesn't cover. */
function subtractAll(
  shown: { from: number; to: number },
  covered: Spans,
): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];
  let at = shown.from;
  for (const span of covered) {
    if (span.to <= at) continue;
    if (span.from >= shown.to) break;
    if (span.from > at) gaps.push({ from: at, to: span.from });
    at = Math.max(at, span.to);
  }
  if (at < shown.to) gaps.push({ from: at, to: shown.to });
  return gaps;
}

function union(spans: Spans, more: Spans): Spans {
  const all = [...spans, ...more].sort((x, y) => x.from - y.from);
  const merged: { from: number; to: number }[] = [];
  for (const span of all) {
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}
