import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import {
  type AnnotationDraft,
  type AnnotationIndex,
  type AnnotationType,
  type AnnotationsView,
  type DocumentSigning,
  type LocalDecisions,
  type ReplyDraft,
  type Role,
  type SignatureIndex,
  SuggestionTooLarge,
  TextTooLarge,
  draftAddition,
  draftReply,
  sealAnnotation,
  sealReply,
  tryDraftAnnotation,
  writeAnnotation,
  writeReply,
} from "../../../lib/src/index.js";
import { revealInDrawnBlock } from "../../editor/drawn-blocks.js";
import type { DocumentEditor } from "../../editor/editor.js";
import { locate } from "../../editor/located-passage.js";
import { t } from "../../i18n/index.js";
import { count, span } from "../../perf/index.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import type { AwaitingIndex } from "../../view-model/awaiting-index.js";
import { lastEntryId } from "../../view-model/awaiting.js";
import {
  OWN_SIGNATURE,
  type OwnSignature,
} from "../../view-model/own-signature.svelte.js";
import type { SetAside } from "../../view-model/set-aside.js";
import Panel from "./AnnotationsPanel.svelte";
import { AnnotationTexts } from "./annotation-texts.js";
import {
  type CardModel,
  type ThenText,
  cardModel,
  cardOrder,
  keepUnchanged,
  signedByKey,
} from "./card-model.js";
import type { Layout } from "./panel-layout.js";
import { SIGNER_KEYS, type SignerKeys } from "./signer-keys.svelte.js";
import { thenTextAt } from "./then-text.js";

const NONE: ReadonlySet<string> = new Set();

/** What the user did in the panel, reported before it is carried out (for
 * scenario traces, `trace/`). */
/** What the panel wrote that may notify (ADR-0060 §5): a reply, once
 * written; a rejection, once proposed (it notifies once confirmed). An
 * annotation, once written, notifies nobody: it invites to be notified
 * (NI1). */
export type Written =
  | { kind: "annotation" }
  | { kind: "reply"; draft: ReplyDraft }
  | { kind: "rejection"; annotationId: string };

export type PanelAction =
  | {
      kind: "create";
      type: string;
      from: number;
      to: number;
      extra: string;
      note?: string;
      /** An addition's place, when not the selection's end. */
      addAt?: number;
    }
  | { kind: "propose"; id: string; decision: "accept" | "reject" }
  | { kind: "resolve"; id: string }
  | { kind: "reply"; id: string; body: string };

export interface AnnotationsPanel {
  /** Creates an annotation of `type` on the editor's selection: what the
   * selection toolbar does, and the trace replay.
   * Returns an error to show, or nothing. */
  create(
    type: AnnotationType,
    extra: string,
    note: string,
    at?: number,
  ): string | undefined;
  /** Proposes a decision on a suggestion; an error to show, or nothing. */
  decide(id: string, decision: "accept" | "reject"): string | undefined;
  /** Proposes resolving a comment. */
  resolve(id: string): void;
  /** Replies to an annotation (ADR-0035), signed by the author; an error
   * to show, or nothing. What the card's field calls, and the trace
   * replay. */
  reply(id: string, body: string): string | undefined;
  /** The annotation in focus, shared with the editor. */
  readonly active: ActiveAnnotation;
  /** List, margin or bottom sheet. */
  setLayout(layout: Layout): void;
  /** In the sheet layout: shows it, on the active card. */
  openSheet(): void;
  /** The review: the sheet walks through what is left to
   * decide, and goes on after each decision. */
  setReview(on: boolean): void;
  /** In the sheet: the previous or next card. */
  step(by: number): void;
  /** In the sheet: decides on the card shown, if this link may;
   * `accept` resolves a comment. */
  act(action: "accept" | "reject"): void;
  /** The card the sheet shows. */
  shownId(): string | undefined;
  /** The list of open cards, which the margin places. */
  openList(): HTMLElement | undefined;
  /** Called after each rendering (the margin places the cards again). */
  onRendered(listener: () => void): () => void;
  /** Called when a card's annotated text is shown, with where it stands
   * today: the preview, when shown, brings it into view. */
  onLocated(listener: (at: number) => void): () => void;
  destroy(): void;
}

/** Mounts the annotations panel (`AnnotationsPanel.svelte`, ADR-0016): a card
 * per annotation, with what this link may do with it,
 * and the crossings said on both cards (ADR-0012, layer 2). Creating goes
 * through `create`, which the selection toolbar calls. Talks only to
 * `annotations/index.js` and the editor's selection — never directly to
 * `transport` or Loro internals beyond what those already expose
 * (AGENTS.md §3). Renders from the shared index: at once after its own
 * actions, otherwise when the index notifies — never twice for the same
 * state, and always synchronously (`flushSync`), as the tests, the
 * simulation and the trace replay expect. */
export function createAnnotationsPanel(
  container: Element,
  editor: DocumentEditor,
  index: AnnotationIndex,
  /** Read at each action: the pseudonym may change. */
  author: () => string,
  decisions: LocalDecisions,
  onAction: (action: PanelAction) => void = () => {},
  /** What the link may do (ADR-0019 §1): a reader only reads, a reviewer
   * creates, an editor also decides and resolves. */
  role: Role = "edit",
  active: ActiveAnnotation = new ActiveAnnotation(),
  /** Signs what is written (docs/protocol/06-identity.md): drafted at
   * once — its errors said at once —, written once signed, never after the
   * panel is gone. Without it, written at once,
   * unsigned. */
  signing?: DocumentSigning,
  /** The document's signatures, shown on the cards (ID-17); without it,
   * every name as before. */
  signatures?: SignatureIndex,
  /** This browser's key and why it doesn't carry the name. */
  own?: OwnSignature,
  /** What awaits my reply, and what I set aside (ADR-0050): marked on the
   * cards; without it, nothing marked. */
  awaiting?: { index: AwaitingIndex; setAside: SetAside },
  /** Mine, and what each key signed, which the panel keeps (ADR-0051
   * §3): said in a mark's details. */
  keys?: SignerKeys,
  /** Told of an annotation or a reply once written, and of a rejection
   * once proposed: what may notify (ADR-0060 §5), or invite to be
   * notified. */
  onWritten: (written: Written) => void = () => {},
): AnnotationsPanel {
  const { contentDoc, annotationsDoc } = index;
  let destroyed = false;
  /** Writes a draft: at once unsigned, or once its seal is made. */
  function write(draft: AnnotationDraft): void {
    if (!signing) {
      writeAnnotation(annotationsDoc, draft);
      onWritten({ kind: "annotation" });
      render();
      return;
    }
    void sealAnnotation(signing, draft).then((seal) => {
      if (destroyed) return;
      writeAnnotation(annotationsDoc, draft, seal);
      onWritten({ kind: "annotation" });
      render();
    });
  }
  function create(
    type: AnnotationType,
    extra: string,
    note: string,
    at?: number,
  ): string | undefined {
    const { from, to } = editor.view.state.selection.main;
    onAction({
      kind: "create",
      type,
      from,
      to,
      extra,
      ...(note && { note }),
      ...(at !== undefined && { addAt: at }),
    });
    // A suggestion's note says why (a comment's text is its body).
    const why = type !== "comment" && note ? { note } : {};
    if (type === "addition") {
      if (extra.length === 0) return t().typeTextFirst;
      if (contentDoc.getText("content").length === 0) {
        return t().emptyDocumentAddition;
      }
      // Proposed at the cursor (selection end), or where the toolbar
      // places it; never written to content (ADR-0018); can
      // never cross an existing annotation.
      let draft: AnnotationDraft;
      try {
        draft = draftAddition(contentDoc, {
          at: at ?? to,
          text: extra,
          author: author(),
          ...why,
        });
      } catch (error) {
        if (error instanceof SuggestionTooLarge) {
          return t().suggestionTooLarge;
        }
        throw error;
      }
      write(draft);
      return undefined;
    }
    if (type === "substitution" && extra.length === 0) {
      return t().typeReplacementFirst;
    }
    let result: ReturnType<typeof tryDraftAnnotation>;
    try {
      result = tryDraftAnnotation(contentDoc, annotationsDoc, {
        type,
        start: from,
        end: to,
        author: author(),
        ...why,
        ...(type === "substitution" ? { replacement: extra } : {}),
        ...(type === "comment" ? { body: extra } : {}),
      });
    } catch (error) {
      if (error instanceof SuggestionTooLarge) {
        return t().suggestionTooLarge;
      }
      // A comment's body (ADR-0035, Conséquences).
      if (error instanceof TextTooLarge) return t().textTooLarge;
      throw error;
    }
    if (!result.ok) return t().conflictsWith(result.conflictWith);
    write(result.draft);
    return undefined;
  }

  function decide(id: string, decision: "accept" | "reject") {
    onAction({ kind: "propose", id, decision });
    // An acceptance carries the change as shown now (ADR-0018): what
    // every editor imports, whatever the annotation says later.
    const change =
      decision === "accept" ? index.current().byId.get(id)?.change : undefined;
    const sent = decisions.propose(id, decision, author(), change);
    if (sent && decision === "reject") {
      onWritten({ kind: "rejection", annotationId: id });
    }
    render();
    const problem = sent ? undefined : t().tooLargeToAccept;
    panel.fail(problem ?? "");
    flushSync();
    return problem;
  }

  function resolve(id: string) {
    onAction({ kind: "resolve", id });
    decisions.propose(id, "resolve", author());
    render();
  }

  function reply(id: string, body: string): string | undefined {
    // The card offers it on an open annotation only (ADR-0035 §4); a
    // reader has no field.
    if (role === "read") return undefined;
    if (body.trim() === "") return t().typeReplyFirst;
    onAction({ kind: "reply", id, body });
    let draft: ReturnType<typeof draftReply>;
    try {
      draft = draftReply(annotationsDoc, id, { author: author(), body });
    } catch (error) {
      if (error instanceof TextTooLarge) return t().textTooLarge;
      throw error;
    }
    if (!signing) {
      writeReply(annotationsDoc, draft);
      onWritten({ kind: "reply", draft });
      render();
      return undefined;
    }
    void sealReply(signing, draft).then((seal) => {
      if (destroyed) return;
      try {
        writeReply(annotationsDoc, draft, seal);
      } catch {
        // Its annotation was deleted meanwhile: nothing to reply to.
        return;
      }
      onWritten({ kind: "reply", draft });
      render();
    });
    return undefined;
  }

  /** « Nothing to add », or put back (ADR-0050 §4): at its last entry. */
  function setAside(id: string, aside: boolean): void {
    // Not traced: nothing is written to the document.
    if (!awaiting) return;
    const annotation = index.current().byId.get(id);
    if (aside && annotation) {
      awaiting.setAside.set(id, lastEntryId(annotation));
    } else awaiting.setAside.clear(id);
    render();
  }

  /** The text an annotation covers or covered, at the click on its card
   * (ADR-0052 §4): never on a rendering. Where its range stands today,
   * resolved by the same click, is marked and brought into view, the card
   * made active; hidden by its button, the page goes back where it was
   *. */
  let located: { id: string; back: () => void } | undefined;
  const locatedListeners = new Set<(at: number) => void>();
  function seeText(id: string): { text: ThenText; located: boolean } {
    const { text, at } = thenTextAt(contentDoc, annotationsDoc, id);
    if (!at) {
      unlocate(false);
      return { text, located: false };
    }
    const view = editor.view;
    located = { id, back: located?.back ?? scrolledBack(view) };
    active.set(id, "card");
    if (editor.hosted) revealInDrawnBlock(view, at.start);
    view.dispatch({
      effects: [
        locate.of({ id, from: at.start, to: at.end }),
        EditorView.scrollIntoView(at.start, { y: "center" }),
      ],
    });
    for (const listener of locatedListeners) listener(at.start);
    return { text, located: true };
  }
  function unlocate(back: boolean): void {
    if (!located) return;
    const goBack = located.back;
    located = undefined;
    editor.view.dispatch({ effects: locate.of(null) });
    if (back) goBack();
  }

  // Each text rendered once while a card shows it (ADR-0047 §9).
  const texts = new AnnotationTexts();
  const panel = mount(Panel, {
    target: container,
    context: new Map<symbol, unknown>([
      ...(own ? [[OWN_SIGNATURE, own] as const] : []),
      ...(keys ? [[SIGNER_KEYS, keys] as const] : []),
    ]),
    props: {
      role,
      texts,
      onSelect(id: string) {
        active.set(id, "card");
      },
      onAction(id: string, action: "accept" | "reject" | "resolve") {
        if (action === "resolve") resolve(id);
        else decide(id, action);
      },
      onReply: reply,
      onSetAside: setAside,
      onSeeText: seeText,
      onHideText: (id: string, back: boolean) => {
        if (located?.id === id) unlocate(back);
      },
      marked: awaiting !== undefined,
      onResize: () => tellRendered(),
    },
  }) as {
    show(cards: ReturnType<typeof cardModel>[]): void;
    setActive(id: string | undefined): void;
    fail(message: string): void;
    setLayout(layout: Layout): void;
    fold(): void;
    openSheet(): void;
    openList(): HTMLElement | undefined;
    setReview(on: boolean): void;
    step(by: number): void;
    act(action: "accept" | "reject"): void;
    shown(): { id: string } | undefined;
  };
  const rendered = new Set<() => void>();
  const tellRendered = () => {
    for (const listener of rendered) listener();
  };

  // The cards drawn last: an unchanged one is not drawn again.
  const cards = new Map<string, CardModel>();
  let shown:
    | {
        view: AnnotationsView;
        decisions: number;
        signed: string;
        awaits: ReadonlySet<string>;
        aside: ReadonlySet<string>;
      }
    | undefined;
  /** The version of the marks the cards show. */
  const marks = () =>
    signatures?.current().version("annotation", "reply", "decision") ?? "";
  function render(): void {
    const view = index.current();
    const signed = signatures?.current();
    const marked = marks();
    const awaits = awaiting?.index.current() ?? NONE;
    const aside = awaiting?.index.aside() ?? NONE;
    if (
      shown?.view === view &&
      shown.decisions === decisions.version &&
      shown.signed === marked &&
      shown.awaits === awaits &&
      shown.aside === aside
    ) {
      return;
    }
    shown = {
      view,
      decisions: decisions.version,
      signed: marked,
      awaits,
      aside,
    };
    count("panel.render");
    span("panel", () => {
      const text = contentDoc.getText("content").toString();
      const next = keepUnchanged(
        cards,
        view.annotations.map((annotation) =>
          cardModel(
            annotation,
            view,
            decisions,
            role,
            text,
            signed,
            awaits.has(annotation.id)
              ? "awaiting"
              : aside.has(annotation.id)
                ? "set-aside"
                : undefined,
          ),
        ),
      );
      texts.keep(next);
      if (keys) keys.signed = signedByKey(next);
      panel.show(cardOrder(next));
      flushSync(); // rendered now, as the DOM panel was
    });
    tellRendered();
  }

  const unsubscribe = index.subscribe(render);
  // A verification ended, a key arrived: drawn again only if a card's
  // mark changed — never for a name registered in `peers` (the first
  // keystroke registers this page's).
  const unsign = signatures?.subscribe(() => {
    if (shown && shown.signed !== marks()) render();
  });
  const unawait = awaiting?.index.subscribe(() => {
    if (
      shown &&
      (shown.awaits !== awaiting.index.current() ||
        shown.aside !== awaiting.index.aside())
    ) {
      render();
    }
  });
  const unfollow = active.subscribe((id) => {
    // Another card chosen: the marked one folded, where it is.
    if (located && located.id !== id) {
      unlocate(false);
      panel.fold();
    }
    panel.setActive(id);
    flushSync();
    tellRendered();
  });
  render();
  return {
    create,
    decide,
    resolve,
    reply,
    active,
    setLayout(layout) {
      panel.setLayout(layout);
      flushSync();
      tellRendered();
    },
    openSheet() {
      panel.openSheet();
      flushSync();
    },
    openList: () => panel.openList(),
    setReview(on) {
      panel.setReview(on);
      flushSync();
    },
    step(by) {
      panel.step(by);
      flushSync();
    },
    act(action) {
      panel.act(action);
      flushSync();
    },
    shownId: () => panel.shown()?.id,
    onRendered(listener) {
      rendered.add(listener);
      return () => rendered.delete(listener);
    },
    onLocated(listener) {
      locatedListeners.add(listener);
      return () => locatedListeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      unsign?.();
      unawait?.();
      unfollow();
      void unmount(panel);
    },
  };
}

/** Puts back the scroll of what scrolls the editor, as it is now: its
 * first ancestor that scrolls, else the page. CodeMirror's own snapshot
 * knows its scroller alone, and the page scrolls the window. */
function scrolledBack(view: EditorView): () => void {
  const window = view.dom.ownerDocument.defaultView;
  let scroller: Element | null = null;
  for (let at: Element | null = view.scrollDOM; at; at = at.parentElement) {
    const overflow = window?.getComputedStyle(at).overflowY ?? "";
    if (/auto|scroll/.test(overflow) && at.scrollHeight > at.clientHeight) {
      scroller = at;
      break;
    }
  }
  scroller ??= view.dom.ownerDocument.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  return () => {
    if (scroller) scroller.scrollTop = top;
  };
}
