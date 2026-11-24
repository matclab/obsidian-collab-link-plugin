import type { LoroDoc } from "loro-crdt";
import { type TFile, type Vault, normalizePath } from "obsidian";
import { type MountedView, documentTitle } from "../../web/src/embed.js";
import { NoteExporter, type Outside } from "./exporter.js";
import { ImageWriter } from "./image-writer.js";
import type { ViewHost } from "./leaf-view.js";
import {
  foundFormat,
  imageFile,
  imageFolder,
  notedImages,
  toDocument,
  toNote,
} from "./vault-images.js";
import { isRenameRewrite } from "./wikilinks.js";

/** `path` and the folders above it, made if missing. */
export async function folderMade(vault: Vault, path: string): Promise<void> {
  let at = "";
  for (const segment of normalizePath(path).split("/")) {
    at = at ? `${at}/${segment}` : segment;
    if (vault.getAbstractFileByPath(at)) continue;
    await vault.createFolder(at).catch(() => {});
  }
}

/** A shown document's note: its export, and its attached images as files of the
 * vault (ADR-0058). Started; nothing awaited. */
export function startExport(options: {
  vault: Vault;
  host: Pick<
    ViewHost,
    "images" | "notes" | "vaultLinks" | "exportDelayMs" | "setTimer"
  >;
  documentId: string;
  mounted: MountedView;
  content: LoroDoc;
  /** The note, while the view shows it. */
  note: () => TFile | null;
  /** A change from outside was kept, and is about to be written over. */
  onOutside: (outside: Outside) => void;
  /** A rename's rewrite of the export: to resume, no copy (LK5). */
  onRecognized: (outside: Outside) => void;
}): { exporter: NoteExporter<TFile>; images: ImageWriter | undefined } {
  const { vault, host, documentId, mounted, content, note } = options;
  const { image } = mounted;
  const found = (id: string) =>
    foundFormat(
      (path) => vault.getAbstractFileByPath(normalizePath(path)) !== null,
      host.images.folder(),
      documentId,
      id,
    );
  const images =
    image &&
    new ImageWriter({
      enabled: () => host.images.inVault(),
      found,
      image,
      create: async (id, opened) => {
        const folder = host.images.folder();
        await folderMade(vault, imageFolder(folder, documentId));
        await vault.createBinary(
          normalizePath(imageFile(folder, documentId, id, opened.format)),
          opened.bytes.slice().buffer,
        );
      },
      // Once a file is written: after the exporter exists.
      written: () => exporter.changed(),
    });
  const exporter: NoteExporter<TFile> = new NoteExporter({
    doc: content,
    documentId,
    file: () => note() ?? undefined,
    process: (note, fn) => vault.process(note, fn),
    keep: async (text) => {
      const shownIn = note();
      if (!shownIn) throw new Error("the note is gone");
      return (await host.notes.keepCopy(shownIn, text)).basename;
    },
    onOutside: options.onOutside,
    recognize: (exported, found) =>
      isRenameRewrite(exported, found, host.vaultLinks.renames()),
    onRecognized: options.onRecognized,
    ...(mounted.imported && { imported: mounted.imported }),
    toNote: (text) =>
      toNote(text, documentId, host.images.folder(), (id) =>
        host.images.inVault() ? found(id) : undefined,
      ),
    toDocument: (text) => toDocument(text, documentId),
    exported: (text) => images?.cited(notedImages(text)),
    delayMs: host.exportDelayMs(),
    setTimer: (run, ms) => host.setTimer(run, ms),
  });
  exporter.start();
  return { exporter, images };
}

/** A note "Open a link" created follows its title while its first view shows it
 * — once the typing pauses, not at its first letter —, until the user names it.
 * Returns how to stop. */
export function followTitle(options: {
  host: Pick<ViewHost, "notes" | "exportDelayMs" | "setTimer">;
  file: TFile;
  note: () => TFile | null;
  content: LoroDoc;
}): () => void {
  const { host, file, note, content } = options;
  let timer: (() => void) | undefined;
  let given = file.basename;
  const name = () => {
    timer = undefined;
    const shownIn = note();
    if (!shownIn || shownIn.basename !== given) {
      stop();
      return;
    }
    const title = documentTitle(content.getText("content").toString());
    if (!title) return;
    void host.notes.nameAfter(shownIn, title).then((named) => {
      given = named;
    });
  };
  const unsubscribe = content.subscribe(() => {
    timer?.();
    timer = host.setTimer(name, host.exportDelayMs());
  });
  const stop = () => {
    timer?.();
    unsubscribe();
  };
  name();
  return stop;
}
