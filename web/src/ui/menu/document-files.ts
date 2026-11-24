import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import {
  type AnnotationIndex,
  type DecisionLog,
  type Role,
  type SignatureIndex,
  checkDetachedChange,
  computeAnnotationsView,
  replyKey,
} from "../../../lib/src/index.js";
import {
  type ImportNotice,
  exportMarkdown,
  importMarkdown,
} from "../../criticmarkup/index.js";
import type { DocumentEditor } from "../../editor/editor.js";
import {
  EXTENSIONS,
  citedImages,
  withImagePaths,
} from "../../files/export-images.js";
import { zip } from "../../files/zip.js";
import { formatShortDate, t } from "../../i18n/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import {
  decidedBy,
  shownName,
  statusOf,
  verbOf,
} from "../annotations/card-model.js";
import { thenText } from "../annotations/then-text.js";
import { documentTitle } from "../document-title.js";
import Files from "./DocumentFiles.svelte";
import { type JournalEntry, journalMarkdown } from "./annotations-journal.js";
import { exportName } from "./export-name.js";

export interface DocumentFiles {
  /** Resolves once the import in progress, if any, is done. */
  imported(): Promise<void>;
  destroy(): void;
}

/** Saves a file through the browser's download, never the network. */
export function download(name: string, text: string | Uint8Array): void {
  const type = typeof text === "string" ? "text/markdown" : "application/zip";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text as BlobPart], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportMessage(
  omitted: number,
  ambiguous: boolean,
  pointed: number,
): string {
  return [
    omitted > 0 && t().exportOmitted(omitted),
    pointed > 0 && t().exportPointed(pointed),
    ambiguous && t().exportAmbiguous,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the import had to change, and what another tool changed in an
 * export (ADR-0034 §5), grouped by kind: the import is into a new
 * document, where nothing shows where things stood. */
function importMessage(notices: readonly ImportNotice[]): string {
  const count = (kind: ImportNotice["kind"]) =>
    notices.filter((notice) => notice.kind === kind).length;
  const said: [number, (n: number) => string][] = [
    [count("moved"), t().importMoved],
    [count("dropped"), t().importDropped],
    [count("orphanNote"), t().importOrphanNote],
    [count("decidedOutside"), t().importDecidedOutside],
    [count("duplicateName"), t().importDuplicateName],
    [count("noNote"), t().importNoNote],
    [count("bareHighlight"), t().importBareHighlight],
  ];
  return [
    t().imported,
    ...said.flatMap(([n, sentence]) => (n > 0 ? [sentence(n)] : [])),
  ].join(" ");
}

/** Export and import of `.md` files (phase 6 decision 8): every role has
 * the key, and exports without the network; an editor imports into an
 * empty document only — merging into a shared text is another problem. */
export function createDocumentFiles(
  container: Element,
  options: {
    editor: DocumentEditor;
    index: AnnotationIndex;
    role: Role;
    /** Read at each import: the pseudonym may change. */
    author: () => string;
    save: (name: string, text: string | Uint8Array) => void;
    /** The document's attached images: with any cited, the export is a
     * `.zip` of its text and their files (ADR-0057 §8). */
    images?: AttachedImages;
    /** Who decided the closed annotations, in the journal (ADR-0052 §2);
     * without it, nobody said. */
    log?: DecisionLog;
    /** The names shown, attested or carried (ADR-0040). */
    signatures?: SignatureIndex;
  },
): DocumentFiles {
  const { editor, index, role, author } = options;
  const { contentDoc, annotationsDoc } = index;
  const text = () => contentDoc.getText("content").toString();
  const empty = () =>
    editor.view.state.doc.length === 0 &&
    index.current().annotations.length === 0;

  /** Every annotation as its card shows it, open or closed, in their
   * creation's order (JA1, JA2): its texts read now, at the export. */
  function journalEntries(): JournalEntry[] {
    const signed = options.signatures?.current();
    const unsigned = { signed: false } as const;
    // Exact ranges: what is written must be (E3).
    const view = computeAnnotationsView(
      contentDoc,
      annotationsDoc,
      undefined,
      false,
    );
    return view.annotations.map((annotation) => {
      const { id, type, status } = annotation;
      const decision =
        type === "comment"
          ? options.log?.resolution(id)
          : options.log?.winner(id);
      const by = decidedBy(annotation, decision, signed);
      const verdict =
        annotation.change &&
        checkDetachedChange(contentDoc, id, annotation.change);
      return {
        author: shownName(
          annotation.author,
          signed?.of("annotation", id) ?? unsigned,
        ),
        verb: verbOf(type),
        when: formatShortDate(annotation.createdAt),
        state: by
          ? `${statusOf(status)}, ${t().decidedBy(by.name)}`
          : statusOf(status),
        ...(type !== "addition" && {
          annotated: thenText(contentDoc, annotationsDoc, id) ?? "unavailable",
        }),
        ...(verdict?.kind === "valid" && { proposal: verdict.text }),
        ...(annotation.body !== undefined && { body: annotation.body }),
        ...(annotation.note !== undefined && { note: annotation.note }),
        replies: annotation.replies.map((reply) => ({
          author: shownName(
            reply.author,
            reply.id !== undefined && signed
              ? signed.of("reply", replyKey(id, reply.id))
              : unsigned,
          ),
          when: formatShortDate(reply.createdAt),
          body: reply.body,
        })),
      };
    });
  }

  const panel = mount(Files, {
    target: container,
    props: {
      onJournal() {
        options.save(
          exportName(text(), " — annotations.md"),
          journalMarkdown(
            documentTitle(text()) ?? t().untitled,
            journalEntries(),
          ),
        );
        panel.say("");
        flushSync();
      },
      onExport(withAnnotations: boolean) {
        if (!withAnnotations) {
          void saveWithImages(text(), ".md", "");
        } else {
          // Exact ranges: what is written must be (E3).
          const result = exportMarkdown(
            text(),
            computeAnnotationsView(
              contentDoc,
              annotationsDoc,
              undefined,
              false,
            ),
          );
          if (result.kind === "crossing") {
            panel.say(t().exportCrossing);
          } else {
            void saveWithImages(
              result.markdown,
              ".annotations.md",
              exportMessage(result.omitted, result.ambiguous, result.pointed),
            );
          }
        }
        flushSync();
      },
      onImport(file: File) {
        importing = importFile(file);
      },
    },
  });

  /** The text as `.md`, or, citing images, as a `.zip` with them; those
   * not found stay cited, and the message says how many. */
  const saveWithImages = async (
    markdown: string,
    suffix: string,
    message: string,
  ) => {
    const name = exportName(text(), suffix);
    const ids = options.images ? citedImages(markdown) : [];
    if (!options.images || ids.length === 0) {
      options.save(name, markdown);
      panel.say(message);
      flushSync();
      return;
    }
    const { images } = options;
    const paths = new Map<string, string>();
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const id of ids) {
      const image = await images.opened(id);
      if (!image) continue;
      const path = `images/${id}.${EXTENSIONS[image.format]}`;
      paths.set(id, path);
      files.push({ name: path, bytes: image.bytes });
    }
    const archive = zip([
      {
        name,
        bytes: new TextEncoder().encode(withImagePaths(markdown, paths)),
      },
      ...files,
    ]);
    options.save(`${name.replace(/\.md$/, "")}.zip`, archive);
    const missing = ids.length - files.length;
    panel.say(
      [message, missing > 0 && t().exportImagesMissing(missing)]
        .filter(Boolean)
        .join(" "),
    );
    flushSync();
  };

  let importing: Promise<void> = Promise.resolve();
  const importFile = async (file: File) => {
    const markdown = await file.text();
    // Someone may have written meanwhile: never merge.
    if (!empty()) {
      panel.say(t().importNotEmpty);
    } else {
      try {
        panel.say(
          importMessage(
            importMarkdown(markdown, contentDoc, annotationsDoc, author()),
          ),
        );
      } catch (error) {
        // The parser's detail stays as written: it names an offset.
        panel.say(
          t().importFailed(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    flushSync();
    update();
  };

  // Only an editor, only while the document is empty: re-rendered when
  // that changes, not on every keystroke (the text's length first: a
  // keystroke resolves no annotation).
  let canImport: boolean | undefined;
  const update = () => {
    const next = role === "edit" && empty();
    if (next !== canImport) {
      canImport = next;
      panel.setCanImport(next);
      flushSync();
    }
  };
  const unsubscribe = index.subscribe(update);
  editor.view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((viewUpdate) => {
        if (viewUpdate.docChanged) update();
      }),
    ),
  });
  update();

  return {
    imported: () => importing,
    destroy() {
      unsubscribe();
      void unmount(panel);
    },
  };
}
