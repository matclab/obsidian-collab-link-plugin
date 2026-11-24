// The shared derived model of the outline (docs/phase-16-plan-du-document.md,
// decision 4): the document's headings, parsed by the editor's parser on
// its own, incrementally, as the text changes.
import { DocInput } from "@codemirror/language";
import type { ChangeDesc, Text } from "@codemirror/state";
import { type ChangedRange, type Tree, TreeFragment } from "@lezer/common";
import { markdownParser } from "../editor/markdown-syntax.js";
import { count } from "../perf/index.js";
import { type OutlineHeading, headingOf, parseWhole } from "./outline.js";

/** The headings of a text that changes.
 *
 * - `update` only records a change: nothing is parsed until the outline is
 *   read (`current`), or, when someone listens, once per microtask.
 * - A parse reuses the previous tree (lezer's fragments); the headings are
 *   looked for from the top-level block before the change, until a block
 *   starts where one started before it: from there on, the text and its
 *   blocks are the same, and the previous headings are only moved.
 * - Listeners are told at most once per microtask, and only when the list
 *   shown — levels and texts — changed: a heading moved by typing above
 *   it tells nobody. */
export class OutlineIndex {
  private tree: Tree;
  private doc: Text;
  private parsedDoc: Text;
  private headings: OutlineHeading[];
  private pending: ChangeDesc | undefined;
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  /** The list shown changed since the listeners were last told: however
   * it was found out — a read between a change and the notification
   * finds it first. */
  private untold = false;

  constructor(
    doc: Text,
    /** When a listener is told (default: a microtask); a test's choice.
     * Called as a method: the default calls `queueMicrotask` on its own,
     * which a browser refuses with another `this` ("Illegal invocation"). */
    private readonly schedule: (run: () => void) => void = (run) =>
      queueMicrotask(run),
  ) {
    this.doc = this.parsedDoc = doc;
    count("outline.parse");
    this.tree = parseWhole(doc);
    this.headings = [];
    for (
      let node = this.tree.topNode.firstChild;
      node;
      node = node.nextSibling
    ) {
      count("outline.block");
      const heading = headingOf(node, this.tree, doc);
      if (heading) this.headings.push(heading);
    }
  }

  /** The text changed by `changes`, to `doc`. */
  update(changes: ChangeDesc, doc: Text): void {
    if (changes.empty) return;
    this.pending = this.pending ? this.pending.composeDesc(changes) : changes;
    this.doc = doc;
    if (this.listeners.size > 0 && !this.scheduled) {
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        // Nobody left to tell: nothing to work out (the column closed).
        if (this.listeners.size === 0) return;
        this.refresh();
        if (!this.untold) return;
        this.untold = false;
        for (const listener of [...this.listeners]) listener();
      });
    }
  }

  current(): readonly OutlineHeading[] {
    this.refresh();
    return this.headings;
  }

  /** Told when the list shown changed. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Brings the outline up to the text; notes when the list shown
   * changed. */
  private refresh(): void {
    const changes = this.pending;
    if (!changes) return;
    this.pending = undefined;
    const oldTree = this.tree;
    const oldDoc = this.parsedDoc;
    const doc = this.doc;
    const ranges: ChangedRange[] = [];
    let changedFrom = doc.length;
    let changedTo = 0;
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      ranges.push({ fromA, toA, fromB, toB });
      changedFrom = Math.min(changedFrom, fromB);
      changedTo = Math.max(changedTo, toB);
    });
    count("outline.parse");
    const tree = markdownParser().parse(
      new DocInput(doc),
      TreeFragment.applyChanges(TreeFragment.addTree(oldTree), ranges),
    );
    this.tree = tree;
    this.parsedDoc = doc;

    // From the block before the one the change starts in: a change may
    // end the block above (a list's marker undone continues the paragraph
    // above it, an underline makes it a heading).
    const top = tree.topNode;
    const before = top.childBefore(changedFrom);
    const start = before ? (before.prevSibling ?? before) : top.firstChild;
    // In line starts, as the headings' `from` (a block may be indented).
    // No block before the change: nothing above it is kept.
    const from = before && start ? doc.lineAt(start.from).from : 0;

    const found: OutlineHeading[] = [];
    // Where the old list resumes, in the old text and the new.
    let resumeOld = Number.POSITIVE_INFINITY;
    let resumeNew = 0;
    for (let node = start; node; node = node.nextSibling) {
      if (node.from > changedTo) {
        const old = changes.invertedDesc.mapPos(node.from);
        const before = oldTree.topNode.childAfter(old);
        if (before && before.from === old && before.name === node.name) {
          resumeOld = old;
          resumeNew = node.from;
          break;
        }
      }
      count("outline.block");
      const heading = headingOf(node, tree, doc);
      if (heading) found.push(heading);
    }

    const previous = this.headings;
    const resumed = resumeOld !== Number.POSITIVE_INFINITY;
    const oldLine = resumed ? oldDoc.lineAt(resumeOld) : undefined;
    const newLine = resumed ? doc.lineAt(resumeNew) : undefined;
    const resumeAt = oldLine?.from ?? Number.POSITIVE_INFINITY;
    const kept = previous.filter((h) => h.from < from);
    const replaced = previous.filter(
      (h) => h.from >= from && h.from < resumeAt,
    );
    // The text from the block resumed at on is the same, moved by `shift`;
    // its own line may have changed before it (an indent): a heading there
    // starts where that line starts now.
    const shift = resumeNew - resumeOld;
    const lineShift = (newLine?.number ?? 0) - (oldLine?.number ?? 0);
    const moved = previous
      .filter((h) => h.from >= resumeAt)
      .map((h) => ({
        ...h,
        from: h.from === resumeAt ? (newLine?.from ?? 0) : h.from + shift,
        line: h.line + lineShift,
      }));
    this.headings = [...kept, ...found, ...moved];
    this.untold ||=
      replaced.length !== found.length ||
      replaced.some((h, i) => {
        const now = found[i] as OutlineHeading;
        return (
          h.level !== now.level ||
          h.text !== now.text ||
          h.source !== now.source
        );
      });
  }
}
