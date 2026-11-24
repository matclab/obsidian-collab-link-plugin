import type { LoroDoc } from "loro-crdt";
import { flushSync, mount, unmount } from "svelte";
import {
  type DocumentSigning,
  type Role,
  type SignatureIndex,
  type SignatureView,
  type Verdict,
  type VersionDraft,
  draftVersion,
  sealVersion,
  writeVersion,
} from "../../../lib/src/index.js";
import {
  deleteVersion,
  diffVersions,
  restoreText,
  textAt,
} from "../../history/index.js";
import { formatDate, t } from "../../i18n/index.js";
import { count } from "../../perf/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import type { RemoteImages } from "../../view-model/remote-images.js";
import { shownName } from "../annotations/card-model.js";
import {
  type PreviewLoaders,
  RENDER_DELAY_MS,
  createTextPreview,
} from "../reading/preview.js";
import View from "./HistoryView.svelte";
import {
  type HistoryEntry,
  HistoryModel,
  type HistoryRow,
} from "./history-model.js";

export interface HistoryView {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  destroy(): void;
}

type Mode = "text" | "changes";

/** The history in place of the editor: every role
 * sees the versions, a past one rendered or compared with the current
 * text; editors and reviewers name versions and delete names; editors
 * restore a version's text. Hidden, it costs nothing — not even a
 * subscription; shown, it follows both docs, the list and the selected
 * version computed again after a pause, never per keystroke. */
export function createHistoryView(
  container: Element,
  options: {
    contentDoc: LoroDoc;
    annotationsDoc: LoroDoc;
    role: Role;
    /** Read when naming: the pseudonym may change. */
    author: () => string;
    confirm: (message: string) => boolean;
    loaders?: Partial<PreviewLoaders>;
    now?: () => number;
    /** Signs a version's name (docs/protocol/06-identity.md): written
     * once signed, never after the view is gone. */
    signing?: DocumentSigning;
    /** Whose names are signed, shown with the version chosen. */
    signatures?: SignatureIndex;
    /** The reader's grants of remote images (ADR-0055 §6): a past
     * version has no caret. */
    images?: RemoteImages;
    /** The document's attached images (ADR-0057 §8). */
    attached?: AttachedImages;
  },
): HistoryView {
  const {
    contentDoc,
    annotationsDoc,
    role,
    author,
    confirm,
    signing,
    signatures,
  } = options;
  let destroyed = false;
  /** The version of the marks last shown. */
  let shownMarks = "";
  const now = options.now ?? Date.now;
  const model = new HistoryModel(contentDoc, annotationsDoc);
  const root = document.createElement("div");
  root.className = "history";
  root.hidden = true;
  container.append(root);
  const controls = document.createElement("div");
  const textPane = document.createElement("div");
  textPane.className = "history-text";
  const changesPane = document.createElement("div");
  changesPane.className = "history-changes";
  changesPane.hidden = true;
  root.append(controls, textPane, changesPane);

  let visible = false;
  let selected: string | undefined;
  let mode: Mode = "text";
  let shownText = "";
  let unsubscribes: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preview = createTextPreview(
    textPane,
    () => shownText,
    options.loaders,
    {
      ...(options.images && { images: options.images }),
      ...(options.attached && { attached: options.attached }),
    },
  );

  const entry = (): HistoryEntry | undefined =>
    model.entries().find((candidate) => candidate.key === selected);

  const view = mount(View, {
    target: controls,
    props: {
      canName: role === "edit" || role === "suggest",
      canRestore: role === "edit",
      onSelect(key: string) {
        selected = key;
        view.setSelected(key);
        refresh();
      },
      onMode(next: Mode) {
        mode = next;
        view.setMode(next);
        refresh();
      },
      onName(name: string) {
        const chosen = entry();
        if (!chosen) return;
        let draft: VersionDraft;
        try {
          draft = draftVersion(chosen.frontiers, {
            name,
            author: author(),
            at: now(),
          });
        } catch {
          // Its only refusal: a name's length (the field bounds it).
          view.setNotice(t().versionNameLength);
          flushSync();
          return;
        }
        view.setSelected(selected); // clears the field
        if (!signing) {
          writeVersion(annotationsDoc, draft);
          refresh();
          return;
        }
        void sealVersion(signing, draft).then((seal) => {
          if (destroyed) return;
          writeVersion(annotationsDoc, draft, seal);
          refresh();
        });
      },
      onDelete() {
        const chosen = entry();
        if (chosen?.kind !== "named") return;
        deleteVersion(annotationsDoc, chosen.id);
        selected = undefined;
        view.setSelected(undefined);
        refresh();
      },
      onRestore() {
        const chosen = entry();
        if (!chosen) return;
        const label = describe(chosen).title;
        const ok = confirm(t().restoreConfirm(label));
        if (!ok) return;
        restoreText(contentDoc, chosen.frontiers, t().restoredFrom(label));
        refresh();
      },
    },
  });

  function refresh(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!visible) return;
    const entries = model.entries();
    const signed = signatures?.current();
    shownMarks = signed?.version("version") ?? "";
    view.setRows(entries.map((entry) => row(entry, signed)));
    const chosen = entries.find((candidate) => candidate.key === selected);
    if (!chosen) {
      if (selected !== undefined) {
        selected = undefined;
        view.setSelected(undefined);
      }
      showNothing();
    } else if (chosen.kind === "named" && !chosen.available) {
      showNothing();
      view.setNotice(t().textNotArrived);
    } else if (mode === "text" || chosen.current) {
      // The current version has nothing to compare with now.
      view.setSummary(undefined);
      count("history.fork");
      shownText = textAt(contentDoc, chosen.frontiers);
      changesPane.hidden = true;
      if (preview.visible) preview.changed();
      preview.show();
    } else {
      count("history.fork");
      preview.hide();
      drawChanges(chosen);
    }
    flushSync();
  }

  function showNothing(): void {
    preview.hide();
    changesPane.hidden = true;
    changesPane.replaceChildren();
  }

  function drawChanges(chosen: HistoryEntry): void {
    const segments = diffVersions(
      contentDoc,
      chosen.frontiers,
      contentDoc.frontiers(),
    );
    const words = (kind: string) =>
      segments
        .filter((segment) => segment.kind === kind)
        .reduce(
          (sum, segment) => sum + (segment.text.match(/\S+/g)?.length ?? 0),
          0,
        );
    view.setSummary({ added: words("added"), removed: words("removed") });
    const pre = document.createElement("pre");
    for (const segment of segments) {
      const tag =
        segment.kind === "added"
          ? "ins"
          : segment.kind === "removed"
            ? "del"
            : "span";
      const node = document.createElement(tag);
      node.textContent = segment.text;
      pre.append(node);
    }
    changesPane.replaceChildren(pre);
    changesPane.hidden = false;
  }

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, RENDER_DELAY_MS);
  };

  return {
    get visible() {
      return visible;
    },
    show() {
      if (visible) return;
      visible = true;
      root.hidden = false;
      unsubscribes = [
        contentDoc.subscribe(later),
        annotationsDoc.subscribe(later),
        ...(signatures
          ? [
              signatures.subscribe(() => {
                const marks = signatures.current().version("version");
                if (marks !== shownMarks) later();
              }),
            ]
          : []),
      ];
      refresh();
    },
    hide() {
      visible = false;
      root.hidden = true;
      clearTimeout(timer);
      timer = undefined;
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      preview.hide();
    },
    destroy() {
      destroyed = true;
      this.hide();
      void unmount(view);
    },
  };
}

const UNSIGNED: Verdict = { signed: false };

/** A named version's signature. Never a group's: a name in `peers` is
 * signed, not the text written under that peer id, which anyone may
 * take (ADR-0004; security review of 18g). */
function signatureOf(entry: HistoryEntry, signed?: SignatureView): Verdict {
  if (!signed || entry.kind !== "named") return UNSIGNED;
  return signed.of("version", entry.id);
}

function row(entry: HistoryEntry, signed?: SignatureView): HistoryRow {
  const { title, detail } = describe(entry);
  const signature = signatureOf(entry, signed);
  return {
    key: entry.key,
    kind: entry.kind,
    title,
    detail,
    current: entry.current,
    available: entry.kind === "group" || entry.available,
    signature,
    signedName: shownName(entry.author ?? "", signature),
  };
}

function describe(entry: HistoryEntry): { title: string; detail: string } {
  if (entry.kind === "named") {
    return {
      title: entry.name,
      detail: `${t().namedBy(entry.author, date(entry.at))}${entry.available ? "" : t().textNotReceived}`,
    };
  }
  const who = entry.author ?? t().unknownAuthor;
  const when =
    entry.start === 0
      ? t().undated
      : entry.start === entry.end
        ? date(entry.start * 1000)
        : `${date(entry.start * 1000)} – ${date(entry.end * 1000)}`;
  const restored =
    entry.messages.length > 0 ? ` (${entry.messages.at(-1)})` : "";
  return { title: `${who}, ${when}`, detail: restored.trim() };
}

function date(ms: number): string {
  return formatDate(ms);
}
