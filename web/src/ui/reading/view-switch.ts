import { flushSync, mount, unmount } from "svelte";
import type {
  AnnotationIndex,
  AnnotationsView,
  DocumentSigning,
  Role,
  SignatureIndex,
} from "../../../lib/src/index.js";
import type { DocumentEditor } from "../../editor/editor.js";
import { storeFormatting } from "../../editor/formatting-preference.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import type { RemoteImages } from "../../view-model/remote-images.js";
import Modes from "../header/Modes.svelte";
import {
  type HistoryView,
  createHistoryView,
} from "../history/history-view.js";
import { attachRemoteImagesBanner } from "../images/remote-images-banner.js";
import { NEVER, type ScreenQuery } from "../view-width.js";
import ReadingNote from "./ReadingNote.svelte";
import Switch from "./ViewSwitch.svelte";
import { type Preview, type PreviewLoaders, createPreview } from "./preview.js";
import { createScrollSync } from "./scroll-sync.js";
import {
  editorPane,
  previewPane,
  storeSideBySide,
  storedSideBySide,
} from "./side-by-side.js";

export type Mode = "write" | "review" | "history";

/** The view chosen in Write (ADR-0064, AC8). */
export type ViewChoice = "formatted" | "source" | "reading";

export interface ViewSwitch {
  preview: Preview;
  history: HistoryView;
  /** The bar above the editor, for the document's other commands. */
  bar: Element;
  /** The mode now, and when it changes or the preview is toggled (the review's
   * sheet, the margin). */
  mode(): Mode;
  /** Whether the editor and its rendering are shown side by side: in Write, on
   * a wide screen, when chosen. */
  sideBySide(): boolean;
  /** Reading, in Write (ADR-0064, AC5): as its toggle does, unless it is
   * shown. Not by a host's editor. */
  showReading(): void;
  /** Told when the mode changes, the preview is toggled or the view goes
   * side by side or back. */
  onMode(listener: (mode: Mode) => void): void;
  destroy(): void;
}

function pendingSuggestions(view: AnnotationsView): number {
  return view.annotations.filter(
    (annotation) =>
      annotation.status === "open" && annotation.type !== "comment",
  ).length;
}

/** The page's modes: Write — the editor, or its preview
 * (ADR-0021 §1) by a toggle over the text, or on a wide screen both side
 * by side, scrolled together — and History, in the same place. A read link
 * opens on the preview, unless this
 * browser keeps the side-by-side view. The modes go in `modesParent` (the
 * page's header), else over the text; the view chosen right after them
 * where the view is wide, else first over the text. */
export function createViewSwitch(
  parent: Element,
  editor: DocumentEditor,
  index: AnnotationIndex,
  role: Role,
  /** Who names versions, how a restore is confirmed; where this device
   * keeps its choices (Source, side by side), if anywhere. */
  historyOptions: {
    author: () => string;
    confirm: (message: string) => boolean;
    preferences?: Storage | undefined;
    signing?: DocumentSigning;
    signatures?: SignatureIndex;
    /** The reader's grants of remote images (ADR-0055); without them,
     * none is ever loaded. */
    images?: RemoteImages;
    /** The document's attached images (ADR-0057 §8); without them, each
     * stays its text. */
    attached?: AttachedImages;
  },
  loaders: Partial<PreviewLoaders> = {},
  modesParent?: Element,
  /** Wide enough for two columns: the view's width; unmeasured, never. */
  wide: ScreenQuery = NEVER,
): ViewSwitch {
  const { preferences, images, attached, ...versions } = historyOptions;
  const bar = document.createElement("div");
  bar.className = "column-tools";
  parent.prepend(bar);
  const preview = createPreview(parent, editor.view, loaders, images, attached);
  const history = createHistoryView(parent, {
    contentDoc: index.contentDoc,
    annotationsDoc: index.annotationsDoc,
    role,
    ...versions,
    loaders,
    ...(images && { images }),
    ...(attached && { attached }),
  });
  // A host's editor loads the text's images itself: the banner is the page's
  // editor's (ADR-0055 §10).
  const banner = document.createElement("div");
  banner.className = "remote-images-place";
  bar.after(banner);
  const stopBanner =
    images && !editor.hosted
      ? attachRemoteImagesBanner(banner, preview, images)
      : undefined;
  let mode: Mode = "write";
  const listeners: ((mode: Mode) => void)[] = [];
  // A host's editor has its own formatting and preview: none of the page's
  // toggles, never the page's preview.
  const own = !editor.hosted;
  let sideOn = own && storedSideBySide(preferences);
  // Asked for; shown in Write, unless side by side is.
  let previewOn = own && role === "read";
  const sync = createScrollSync(
    editorPane(editor.view),
    previewPane(preview.root),
  );
  // Side by side: an option of Source's (ADR-0064, AC9).
  const side = () =>
    mode === "write" &&
    sideOn &&
    wide.matches() &&
    !previewOn &&
    !editor.formatting();
  const previewing = () => mode === "write" && previewOn;
  const told = () => {
    for (const listener of listeners) listener(mode);
  };
  const modesHost = modesParent ?? bar;
  const modes = mount(Modes, {
    target: modesHost,
    ...(modesParent ? {} : { anchor: bar.firstChild ?? undefined }),
    props: {
      onMode(next: Mode) {
        if (next === mode) return;
        mode = next;
        apply();
        told();
      },
    },
  });
  /** One of three views (ADR-0064, AC8): Reading isn't kept, the others
   * are, as Source was. */
  const choose = (view: ViewChoice) => {
    previewOn = view === "reading";
    if (view !== "reading" && editor.formatting() !== (view === "formatted")) {
      editor.setFormatting(view === "formatted");
      storeFormatting(view === "formatted", preferences);
    }
    apply();
    // The margin follows the text shown.
    told();
  };
  // A place of its own, whatever the bar holds: no button moves as the
  // view changes. Not wide, the header has no room for it.
  const switchPlace = document.createElement("div");
  switchPlace.className = "view-switch";
  const placeSwitch = () => {
    const modesRoot = modesParent?.querySelector(":scope > .modes");
    if (modesRoot && wide.matches()) modesRoot.after(switchPlace);
    else bar.prepend(switchPlace);
  };
  const note = own
    ? mount(ReadingNote, {
        target: bar,
        // A read link's header already says it.
        props: { readOnlyNote: role !== "read" },
      })
    : undefined;
  const tools = own
    ? mount(Switch, {
        target: switchPlace,
        props: {
          onChoose: choose,
          onSideBySide() {
            sideOn = !sideOn;
            storeSideBySide(sideOn, preferences);
            apply();
            // The annotations go to the sheet, and come back.
            told();
          },
        },
      })
    : undefined;
  const apply = () => {
    // Review goes through the annotations over the text itself.
    const writing = mode !== "history";
    const both = side();
    if (both || previewing()) {
      if (!preview.visible) preview.show();
    } else preview.hide();
    parent.classList.toggle("side-by-side", both);
    if (both) {
      sync.start();
      sync.align();
    } else sync.stop();
    if (writing) history.hide();
    else history.show();
    // A host's editor's own element too: it would keep its
    // height over the history.
    const hidden = !writing || previewing();
    editor.view.dom.hidden = hidden;
    editor.element.hidden = hidden;
    modes.setMode(mode);
    tools?.setView(
      previewOn ? "reading" : editor.formatting() ? "formatted" : "source",
    );
    tools?.setSideBySide(
      both,
      wide.matches(),
      wide.matches() && !previewOn && !editor.formatting(),
    );
    switchPlace.hidden = mode !== "write";
    note?.setShown(previewing());
    flushSync();
  };
  const showPending = () => {
    const view = index.current();
    note?.setPending(pendingSuggestions(view));
    modes.setOpen(
      view.annotations.filter((annotation) => annotation.status === "open")
        .length,
    );
    flushSync();
  };
  // Rendered again as one types: level with the editor again.
  preview.onRendered(() => {
    if (side()) sync.align();
  });
  wide.onChange(() => {
    if (tools) placeSwitch();
    apply();
    told();
  });
  if (tools) placeSwitch();
  const unsubscribe = index.subscribe(showPending);
  showPending();
  apply();
  return {
    preview,
    history,
    bar,
    mode: () => mode,
    sideBySide: side,
    showReading() {
      if (own && mode === "write" && !previewing()) choose("reading");
    },
    onMode(listener) {
      listeners.push(listener);
    },
    destroy() {
      unsubscribe();
      stopBanner?.();
      history.destroy();
      void unmount(modes);
      if (tools) void unmount(tools);
      if (note) void unmount(note);
      switchPlace.remove();
    },
  };
}
