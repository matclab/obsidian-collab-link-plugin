import { EditorState, Prec, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LoroDoc } from "loro-crdt";
import {
  type Adopt,
  AnnotationIndex,
  DecisionLog,
  type DocumentSigning,
  FRAME_OVERHEAD,
  LocalDecisions,
  MAX_MESSAGE_BYTES,
  type Role,
  SignatureIndex,
  decisionSealer,
  watchDecisionEffects,
} from "../../lib/src/index.js";
import { attachAnnotationDecorations } from "../editor/annotation-decorations.js";
import { revealInDrawnBlock } from "../editor/drawn-blocks.js";
import {
  type DocumentEditor,
  type EditorFactory,
  createDocumentEditor,
} from "../editor/editor.js";
import { hostedAttachedImages } from "../editor/hosted-attached-images.js";
import { imageInsertion } from "../editor/image-insertion.js";
import { attachedImagesFacet } from "../editor/live-widgets.js";
import { attachRemoteImages } from "../editor/remote-image-grants.js";
import { t } from "../i18n/index.js";
import { toBase64 } from "../trace/format.js";
import { TraceRecorder } from "../trace/recorder.js";
import { takeSnapshot } from "../trace/snapshot.js";
import type { Written } from "../ui/annotations/annotations-panel.js";
import {
  type AnnotationsPanel,
  createAnnotationsPanel,
} from "../ui/annotations/annotations-panel.js";
import { attachAwaitingNav } from "../ui/annotations/awaiting-nav.js";
import { attachKeyNav } from "../ui/annotations/key-nav.js";
import { type MarginPlace, attachMargin } from "../ui/annotations/margin.js";
import { attachSelectionToolbar } from "../ui/annotations/selection-toolbar.js";
import { SignerKeys } from "../ui/annotations/signer-keys.svelte.js";
import {
  type AuthorshipView,
  attachAuthorshipView,
} from "../ui/history/authorship-view.js";
import { createDocumentFiles, download } from "../ui/menu/document-files.js";
import { attachPreviewMarks } from "../ui/reading/preview-marks.js";
import type { PreviewLoaders } from "../ui/reading/preview.js";
import {
  type ViewSwitch,
  createViewSwitch,
} from "../ui/reading/view-switch.js";
import { createFormatToolbar } from "../ui/writing/format-toolbar.js";
import {
  ActiveAnnotation,
  type ActiveOrigin,
} from "../view-model/active-annotation.js";
import type { AttachedImages } from "../view-model/attached-images.js";
import { AwaitingIndex, type MeSource } from "../view-model/awaiting-index.js";
import type { OwnSignature } from "../view-model/own-signature.svelte.js";
import { PageMe } from "../view-model/page-me.js";
import { createRemoteImages } from "../view-model/remote-images.js";
import { SetAside } from "../view-model/set-aside.js";

export interface WiredClient {
  editor: DocumentEditor;
  /** The shared derived model every view renders from. */
  index: AnnotationIndex;
  /** Source or preview (ADR-0021 §1). */
  views: ViewSwitch;
  log: DecisionLog;
  decisions: LocalDecisions;
  /** The document's signatures, verified once each: tell it `opened()` once the
   * history is imported. */
  signatures: SignatureIndex;
  /** The annotations panel: its actions are the interface's. */
  panel: AnnotationsPanel;
  /** What I set aside (ADR-0050 §4). */
  setAside: SetAside;
  /** What awaits my reply (ADR-0050 §1). */
  awaiting: AwaitingIndex;
  /** Makes the annotation the active one, as a click on its card. */
  show(id: string): void;
  /** Goes to the first, the next or the previous of what awaits my reply,
   * in the text's order (ADR-0050 §5); none for a reader. */
  stepAwaiting?: (by: -1 | 0 | 1) => void;
  /** For the transport's `decisions.onConfirmed`. */
  confirm(batch: { seq: number; record: Uint8Array }[]): void;
  /** For the transport's `onImport`. */
  imported(channel: "content" | "annotations", updates: Uint8Array[]): void;
  /** Who wrote (ADR-0059): its switch and legend. */
  authorship: AuthorshipView;
  /** Present when tracing. */
  recorder?: TraceRecorder;
}

/** Wires one client's modules together — editor, decorations, decisions
 * and their effects, panel — the way the page runs them. Shared by
 * `main.ts` and the trace replay (`trace/replay.ts`), so that a replay
 * exercises exactly the page's wiring; only the network stays outside. */
export function wireClient(options: {
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  editorParent: Element;
  panelParent: Element;
  /** Where the modes go (the page's header); default: over the editor. */
  modesParent?: Element;
  /** Where export and import go (the document menu); default: the bar
   * over the editor. */
  filesParent?: Element;
  /** The page's layout of the annotations: in the margin, or
   * a sheet; omitted (tests, replay), a plain list. */
  margin?: MarginPlace;
  /** Read at each action: the pseudonym may change. */
  author: () => string;
  documentId: string;
  publishDecision: (record: Uint8Array) => void;
  /** The role of the link (default: edit, as a replay runs). */
  role?: Role;
  /** Publishes a change the effects imported (`DocumentConnection.adopt`). */
  adopt?: Adopt;
  trace?: boolean;
  /** The text formatted as it is written; default: the
   * source, as the trace replay shows it. */
  livePreview?: boolean;
  /** Where this device keeps its choices (Source, side by side, the
   * formatting toolbar). */
  preferences?: Storage | undefined;
  /** A Mac's keyboard, for the shortcuts the toolbar names (default:
   * not). */
  mac?: boolean;
  /** Opens the writing help, from the toolbar; without it,
   * the toolbar has no help button. */
  onHelp?: () => void;
  /** A host's editor in Write; default: the
   * page's. */
  editor?: EditorFactory;
  /** Where the preview gets KaTeX and Pele (default: `import()`). */
  previewLoaders?: Partial<PreviewLoaders>;
  /** Asks the user before restoring a version (default: `window.confirm`). */
  confirm?: (message: string) => boolean;
  /** A Loro panic caught in the editor or the annotations' listeners
   * (R3). */
  onTrap?: (error: unknown) => void;
  /** Signs what this client writes (docs/protocol/06-identity.md): its
   * annotations, replies, decisions and versions. Without it (tests, the
   * replay), nothing is signed. */
  signing?: DocumentSigning;
  /** This browser's key and why it doesn't carry the name. */
  ownSignature?: OwnSignature;
  /** Told what the panel writes that may notify (ADR-0060 §5). */
  onWritten?: (written: Written) => void;
  /** What I set aside, as the local record kept it; default: nothing. */
  setAside?: SetAside;
  /** Who « I » am (ADR-0050 §2); default: the author's name, no key. */
  me?: MeSource;
  /** The document's attached images (ADR-0057 §8); without them (tests,
   * the replay), each stays its text. */
  attachedImages?: AttachedImages;
}): WiredClient {
  const role = options.role ?? "edit";
  const { contentDoc, annotationsDoc, author } = options;
  const editor = createDocumentEditor(options.editorParent, contentDoc, {
    readOnly: role !== "edit",
    placeholder: role === "edit" ? t().startWriting : t().emptyDocument,
    ...(options.livePreview !== undefined && {
      livePreview: options.livePreview,
    }),
    ...(options.onTrap && { onTrap: options.onTrap }),
    ...(options.editor && { provide: options.editor }),
  });
  // Decisions (ADR-0013): proposals go out on the decisions channel; the
  // confirmed log alone decides, and its effects are applied from it.
  const log = new DecisionLog();
  const index = new AnnotationIndex(
    contentDoc,
    annotationsDoc,
    log,
    options.onTrap ? { onTrap: options.onTrap } : {},
  );
  // Whoever signed what is shown (docs/protocol/06-identity.md): checked
  // whether this page signs or not.
  const signatures = new SignatureIndex({
    documentId: options.documentId,
    annotationsDoc,
    log,
  });
  // The annotation in focus: a card, a mark, the review.
  const active = new ActiveAnnotation();
  attachAnnotationDecorations(editor.view, index, active);
  // Chosen on a card or in the review, or chosen again: its passage comes
  // into view; in a block a host's editor draws, the caret goes there, and
  // the host shows its source.
  const bringIntoView = (id: string | undefined, origin: ActiveOrigin) => {
    const start = id && index.current().byId.get(id)?.range?.start;
    if (origin === "mark" || typeof start !== "number") return;
    if (editor.hosted) revealInDrawnBlock(editor.view, start);
    editor.view.dispatch({
      effects: EditorView.scrollIntoView(start, { y: "center" }),
    });
  };
  active.subscribe(bringIntoView);
  active.subscribeAgain(bringIntoView);
  // What the reader grants of the remote images (ADR-0055): this view's,
  // and this device's for the document.
  const images = createRemoteImages(options.documentId, options.preferences);
  if (!editor.hosted) attachRemoteImages(editor.view, images);
  // The document's images in the editor's widgets (ADR-0057 §8); in a
  // host's, found by their text, and a file pasted there uploaded (§9).
  if (options.attachedImages) {
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of([
        attachedImagesFacet.of(options.attachedImages),
        ...(editor.hosted
          ? [hostedAttachedImages(), Prec.highest(imageInsertion())]
          : []),
      ]),
    });
  }
  const views = createViewSwitch(
    options.editorParent,
    editor,
    index,
    role,
    {
      author,
      confirm: options.confirm ?? ((message) => window.confirm(message)),
      preferences: options.preferences,
      ...(options.signing && { signing: options.signing }),
      signatures,
      images,
      ...(options.attachedImages && { attached: options.attachedImages }),
    },
    options.previewLoaders,
    options.modesParent,
    options.margin?.wide,
  );
  createDocumentFiles(options.filesParent ?? views.bar, {
    editor,
    index,
    role,
    author,
    save: download,
    log,
    signatures,
    ...(options.attachedImages && { images: options.attachedImages }),
  });

  let confirmed = 0;
  const recorder = options.trace
    ? new TraceRecorder(
        {
          documentId: options.documentId,
          author: author(),
          peers: {
            content: contentDoc.peerIdStr,
            annotations: annotationsDoc.peerIdStr,
          },
        },
        () => takeSnapshot(contentDoc, annotationsDoc, editor.view, confirmed),
      )
    : undefined;
  const decisions = new LocalDecisions(
    log,
    (record) => {
      recorder?.info({
        kind: "published",
        channel: "decisions",
        bytes: toBase64(record),
      });
      options.publishDecision(record);
    },
    undefined,
    MAX_MESSAGE_BYTES - FRAME_OVERHEAD,
    // Only editors decide; the key goes into the annotations doc first.
    options.signing && role === "edit"
      ? decisionSealer(options.signing, annotationsDoc)
      : undefined,
  );
  // Only editors apply effects (docs/phase-5-modele-acces.md, decision
  // 2): the others may not publish what applying them writes, and see the
  // result once an editor's operations arrive.
  if (role === "edit") watchDecisionEffects(index, log, options.adopt);
  const setAside = options.setAside ?? new SetAside();
  const me = options.me ?? new PageMe(author());
  const awaiting = new AwaitingIndex({
    annotations: index,
    decisions,
    signatures,
    me,
    setAside,
    role,
  });
  // Mine, said among the keys of a name (ADR-0051 §3).
  const signerKeys = new SignerKeys();
  const followMine = () => {
    signerKeys.mine = me.current().keys;
  };
  followMine();
  me.subscribe(followMine);
  const panel = createAnnotationsPanel(
    options.panelParent,
    editor,
    index,
    author,
    decisions,
    (action) => recorder?.input(action),
    role,
    active,
    options.signing,
    signatures,
    options.ownSignature,
    { index: awaiting, setAside },
    signerKeys,
    options.onWritten,
  );
  attachPreviewMarks(views.preview, editor.view, index, active);
  // What awaits my reply, beside the modes (ADR-0050 §5): not for a
  // reader, who can't reply.
  const awaitingNav =
    role === "read"
      ? undefined
      : attachAwaitingNav(options.modesParent ?? views.bar, {
          awaiting,
          index,
          active,
          ...(options.margin && { keys: options.margin.keys }),
        });
  // The key brought forward, beside the modes (ADR-0051 §4): a reader
  // too may look at who wrote what.
  attachKeyNav(options.modesParent ?? views.bar, {
    keys: signerKeys,
    index,
    active,
  });
  if (options.margin) {
    attachMargin({
      view: editor.view,
      panel,
      index,
      bar: views.bar,
      workspace: options.margin.workspace,
      keys: options.margin.keys,
      ...(options.margin.narrow && { narrow: options.margin.narrow }),
      views,
    });
  }
  // Who wrote (ADR-0059 §4): its switch after the margin's.
  const authorship = attachAuthorshipView({
    editor,
    contentDoc,
    annotationsDoc,
    parent: options.editorParent as HTMLElement,
    views,
    ...(options.margin?.narrow && { narrow: options.margin.narrow }),
    ...(options.margin?.readingTop && {
      readingTop: options.margin.readingTop,
    }),
  });
  createFormatToolbar(views, editor, {
    role,
    preferences: options.preferences,
    mac: options.mac ?? false,
    ...(options.margin?.narrow && { narrow: options.margin.narrow }),
    ...(options.onHelp && { onHelp: options.onHelp }),
  });
  attachSelectionToolbar(editor.view, options.editorParent as HTMLElement, {
    role,
    create: panel.create,
    views,
  });

  if (recorder) {
    // Edits typed by the user (anything carrying a userEvent: typing,
    // deleting, pasting, undo) — never the editor's own mirroring of Loro
    // (marked remote, and `"set"`).
    editor.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorState.transactionFilter.of((tr) => {
          const userEvent = tr.annotation(Transaction.userEvent);
          if (
            tr.docChanged &&
            userEvent !== undefined &&
            !tr.annotation(Transaction.remote)
          ) {
            recorder.input({
              kind: "edit",
              changes: tr.changes.toJSON(),
              userEvent,
            });
          }
          return tr;
        }),
      ),
    });
  }

  return {
    editor,
    index,
    views,
    log,
    decisions,
    signatures,
    panel,
    setAside,
    awaiting,
    authorship,
    show: (id) => active.set(id, "card"),
    ...(awaitingNav && { stepAwaiting: awaitingNav.step }),
    confirm(batch) {
      recorder?.input({
        kind: "confirm",
        batch: batch.map(({ seq, record }) => ({
          seq,
          record: toBase64(record),
        })),
      });
      confirmed += batch.length;
      log.add(batch);
    },
    imported(channel, updates) {
      const [update, ...more] = updates;
      if (!update) return;
      recorder?.input(
        more.length === 0
          ? { kind: "import", channel, bytes: toBase64(update) }
          : { kind: "importBatch", channel, updates: updates.map(toBase64) },
      );
    },
    ...(recorder && { recorder }),
  };
}
