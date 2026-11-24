import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Annotation,
  ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  type KeyBinding,
  keymap,
  placeholder,
} from "@codemirror/view";
import type { LoroDoc, LoroText } from "loro-crdt";
import { isWasmTrap } from "../../lib/src/index.js";
import {
  EDITOR_ORIGIN,
  type PositionalEdit,
  applyEditorChangesToLoroText,
  loroDeltaToChangeSpec,
} from "../crdt-binding/index.js";
import { t } from "../i18n/index.js";
import type { KatexModule } from "../view-model/katex.js";
import { anchorMenu } from "./anchor-menu.js";
import { drawnBlocksFrame } from "./drawn-blocks.js";
import { runConstruct } from "./format-commands.js";
import { imageInsertion } from "./image-insertion.js";
import { linkClicks, openInNewTab } from "./link-click.js";
import { indentCommand } from "./list-indent.js";
import { liveBlocksExtension } from "./live-blocks.js";
import {
  formattedText,
  livePreviewPlugin,
  livePreviewTheme,
} from "./live-preview.js";
import { katexLoader } from "./live-widgets.js";
import { locatedPassage } from "./located-passage.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { multiClicks } from "./multi-click.js";
import { moveSectionBy } from "./section-commands.js";
import { slashMenu } from "./slash-menu.js";

/** A change of the text from Loro: exactly these changes. */
const remoteSync = Annotation.define<ChangeSet>();

/** The annotations of a change from Loro. Marked `"set"`, the text set
 * from outside, as Obsidian marks its own: its filters (a list
 * renumbered, a line before a table), suggestions and text expansion
 * leave it alone, as they would not another's typing. */
const fromLoro = (changes: ChangeSet) => [
  remoteSync.of(changes),
  Transaction.addToHistory.of(false),
  Transaction.remote.of(true),
  Transaction.userEvent.of("set"),
];

/** A change from Loro is applied as it is: whatever a host's filter adds
 * to it (a plugin's, which may not leave a `"set"` alone) would be in
 * the editor's text only, never in Loro's — every later position, an
 * annotation's, a cursor's, a keystroke's, beside its place. Highest, so
 * run last (CodeMirror runs the filters from the lowest). */
const remoteAsItIs = Prec.highest(
  EditorState.transactionFilter.of((tr) => {
    const changes = tr.annotation(remoteSync);
    if (
      !changes ||
      JSON.stringify(tr.changes.toJSON()) === JSON.stringify(changes.toJSON())
    )
      return tr;
    return { changes, annotations: fromLoro(changes) };
  }),
);

/** The user may type no more (`makeReadOnly`): read by the view's
 * `readOnly`, ahead of a host's own. */
const stopTyping = StateEffect.define<null>();
const typingStopped = StateField.define<boolean>({
  create: () => false,
  update: (stopped, tr) =>
    stopped || tr.effects.some((effect) => effect.is(stopTyping)),
});

/** The formatting shortcuts (relevé 20.0): none with Alt,
 * which is AltGr on Windows; none for headings or lists. */
const FORMAT_KEYS: readonly KeyBinding[] = [
  { key: "Mod-b", run: runConstruct("bold") },
  { key: "Mod-i", run: runConstruct("italic") },
  { key: "Mod-e", run: runConstruct("code") },
  { key: "Mod-k", run: runConstruct("link") },
  { key: "Shift-Mod-x", run: runConstruct("strikethrough") },
];
/** The caret and the placeholder in the page's colors, the text's room
 * inside its frame. A theme of the editor's, scoped like CodeMirror's base
 * theme and after it: page rules lost to it (a black caret, invisible on
 * the dark theme; the text against the frame). */
const pageTheme = EditorView.theme({
  ".cm-content": {
    caretColor: "var(--pencil)",
    padding: "1.25rem var(--text-inset, 1.5rem) 40vh",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--pencil)" },
  ".cm-placeholder": { color: "var(--muted)" },
  // A first hint's frame (ADR-0064, AC4, AC5), over CodeMirror's: the
  // first visit's banner's. Opaque: over a code block, a tint would show.
  ".cm-tooltip.first-hint": {
    border: "none",
    borderLeft: "3px solid var(--pencil)",
    borderRadius: "var(--radius-s)",
    background:
      "linear-gradient(var(--pencil-bg), var(--pencil-bg)), var(--paper)",
    boxShadow: "var(--shadow)",
    color: "var(--ink)",
  },
});

export interface DocumentEditor {
  view: EditorView;
  text: LoroText;
  /** Whether the text is shown formatted, or its source. */
  formatting(): boolean;
  /** Shows the text formatted or its source: the editor's configuration
   * changes, never the text. */
  setFormatting(on: boolean): void;
  /** Takes the editor out of its element (the view closes). */
  destroy(): void;
  /** A host's: its own formatting and preview. */
  readonly hosted: boolean;
  /** Its outermost element, in the one it was built in: the view hides it
   * in History (a host's editor may be in an element of its own). */
  readonly element: HTMLElement;
}

/** An editor a host brings in place of the page's (Obsidian's own, in
 * the plugin). Built in `parent` on `doc`, with the
 * view's `extensions` — the link to Loro, the role, the traps —, which it
 * must keep; it brings its own Markdown, keys, history and formatting.
 * Its `EditorView` is of the page's CodeMirror (the plugin's is Obsidian's). */
export type EditorFactory = (
  parent: Element,
  setup: { doc: string; extensions: Extension[] },
) => {
  view: EditorView;
  /** Its own element, if CodeMirror's is in one (Obsidian's
   * `.markdown-source-view`); default: CodeMirror's. */
  element?: HTMLElement;
  destroy(): void;
};

/** Wires a CodeMirror 6 view to a Loro text container: every Loro delta not
 * produced by this editor — a remote import, but also a local programmatic
 * edit such as accepting a suggestion — is converted (via crdt-binding,
 * never duplicated here) into an editor change, and local edits are
 * converted back into Loro operations. Invariant: after every synchronous
 * step the view's text equals the Loro text; a divergence makes every later
 * keystroke land at stale offsets. Any other writer of this text must commit
 * right away, or its pending ops get swallowed into the editor's next
 * (filtered-out) commit. Markdown with GFM, highlighted. */
export function createDocumentEditor(
  parentEl: Element,
  doc: LoroDoc,
  options: {
    textName?: string;
    /** For a link that may not publish on `content` (ADR-0019 §1): the
     * user can select, never type; the others' edits still show. */
    readOnly?: boolean;
    /** Said in an empty document, where its text would go. */
    placeholder?: string;
    /** A Loro panic CodeMirror caught in a listener or plugin (R3): the page
     * halts (phase 9, L4). Other errors are logged, as CodeMirror does. */
    onTrap?: (error: unknown) => void;
    /** The text formatted as it is written: markup hidden
     * outside the lines being edited. Default: the source. */
    livePreview?: boolean;
    /** Where Ctrl/Cmd+click opens a link (default: a new tab). */
    openLink?: (url: string) => void;
    /** Where the formulas get KaTeX (default: the page's loader). */
    katex?: () => Promise<KatexModule>;
    /** A host's editor; default: the page's. The
     * page's options on Markdown and formatting don't reach it. */
    provide?: EditorFactory;
  } = {},
): DocumentEditor {
  const text = doc.getText(options.textName ?? "content");
  const formattingSlot = new Compartment();
  const formattingOf = (on: boolean) =>
    on
      ? [
          livePreviewPlugin,
          liveBlocksExtension,
          livePreviewTheme,
          formattedText.of(true),
        ]
      : [];
  let formatted = options.livePreview ?? false;
  // Referenced by the subscribe closure below, assigned once the EditorView
  // exists (the page's or a host's).
  let view: EditorView;

  // Another's text (or a decision's, a restore's): out of the undo
  // history, which maps its entries over it — an undo takes back only what
  // was typed here —, and marked remote, as
  // CodeMirror marks it, for a host's plugins.
  const unsubscribe = text.subscribe((batch) => {
    if (batch.by === "local" && batch.origin === EDITOR_ORIGIN) return;
    for (const event of batch.events) {
      if (event.diff.type !== "text") continue;
      const spec = loroDeltaToChangeSpec(event.diff.diff);
      if (spec.length === 0) continue;
      const changes = ChangeSet.of(spec, view.state.doc.length);
      view.dispatch({ changes, annotations: fromLoro(changes) });
    }
  });

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some((tr) => tr.annotation(remoteSync))) return; // avoid feedback loop
    const edits: PositionalEdit[] = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({ from: fromA, to: toA, insert: inserted.toString() });
    });
    applyEditorChangesToLoroText(text, edits);
    doc.commit({ origin: EDITOR_ORIGIN });
  });

  // What every editor of the view keeps: the link to Loro, the role, the
  // traps, its name and what an empty one says. The role and the traps
  // first: their facets keep their first value, and a host's editor
  // brings its own (Obsidian: `readOnly.of(false)`, `console.error`;
  // analysis 17d, I8).
  const viewExtensions = [
    // Its name, for a screen reader; in the tab order for
    // every role, said explicitly: side by side, its column scrolls by
    // itself, and the keyboard reaches it there.
    EditorView.contentAttributes.of({
      "aria-label": t().documentText,
      tabindex: "0",
    }),
    ...(options.placeholder ? [placeholder(options.placeholder)] : []),
    updateListener,
    remoteAsItIs,
    typingStopped,
    // Where a card's annotated text stands, while shown.
    locatedPassage(),
    Prec.highest(
      EditorState.readOnly.compute(
        [typingStopped],
        (state) => (options.readOnly ?? false) || state.field(typingStopped),
      ),
    ),
    // readOnly stops CodeMirror's input and commands, not a host's command
    // or plugin that dispatches: an editor that may not type takes no
    // change of the text but the link's (ADR-0004).
    Prec.highest(
      EditorState.transactionFilter.of((tr) =>
        tr.docChanged && tr.startState.readOnly && !tr.annotation(remoteSync)
          ? []
          : tr,
      ),
    ),
    Prec.highest(
      EditorView.exceptionSink.of((exception: unknown) => {
        if (options.onTrap && isWasmTrap(exception)) {
          options.onTrap(exception);
        } else {
          console.error("CodeMirror plugin crashed:", exception);
        }
      }),
    ),
  ];
  // Closed, it follows the text no more (I4).
  const closing = (destroy: () => void) => () => {
    unsubscribe();
    destroy();
  };
  if (options.provide) {
    const provided = options.provide(parentEl, {
      doc: text.toString(),
      // A block it draws in place of its text keeps an annotation out of
      // sight: framed.
      extensions: [...viewExtensions, drawnBlocksFrame],
    });
    view = provided.view;
    // Its own formatting: the page's Source has nothing to change, and
    // isn't offered (view-switch).
    return {
      view,
      text,
      hosted: true,
      element: provided.element ?? view.dom,
      formatting: () => true,
      setFormatting() {},
      destroy: closing(() => provided.destroy()),
    };
  }

  view = new EditorView({
    state: EditorState.create({
      doc: text.toString(),
      extensions: [
        history(),
        keymap.of([
          // Moving a section.
          { key: "Mod-Shift-ArrowUp", run: (v) => moveSectionBy(v, "up") },
          { key: "Mod-Shift-ArrowDown", run: (v) => moveSectionBy(v, "down") },
          // A word processor's: before CodeMirror's,
          // whose Mod-i (selectParentSyntax) italics replaces.
          ...FORMAT_KEYS,
          // Tab indents, as Obsidian (ADR-0054); a menu open takes it
          // first (menu-list.ts), Escape then Tab leaves the text.
          { key: "Tab", run: indentCommand(1) },
          { key: "Shift-Tab", run: indentCommand(-1) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdownSyntax(),
        // The / menu, and a link's headings
        // (decision 9), once the view gives them: the page's editor only.
        slashMenu(),
        imageInsertion(),
        anchorMenu(),
        linkClicks(options.openLink ?? openInNewTab),
        multiClicks(),
        ...(options.katex ? [katexLoader.of(options.katex)] : []),
        formattingSlot.of(formattingOf(formatted)),
        // Long lines wrap: the text is prose, read in a column.
        EditorView.lineWrapping,
        pageTheme,
        ...viewExtensions,
      ],
    }),
    parent: parentEl,
  });

  return {
    view,
    text,
    hosted: false,
    element: view.dom,
    formatting: () => formatted,
    setFormatting(on) {
      if (on === formatted) return;
      formatted = on;
      view.dispatch({ effects: formattingSlot.reconfigure(formattingOf(on)) });
    },
    destroy: closing(() => view.destroy()),
  };
}

/** The user may no longer type (a deleted document, ADR-0024; an
 * internal error): the text stays, to read and copy. */
export function makeReadOnly(view: EditorView): void {
  view.dispatch({ effects: stopTyping.of(null) });
}
