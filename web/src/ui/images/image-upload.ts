/** Uploading an image and citing it (ADR-0057 §8), loaded on first use:
 * one file after the other, each checked against the server's limit,
 * stripped and encrypted (`prepareImage`), uploaded under the editor's
 * secret of now; its reference goes in only once the server stored it,
 * where its slot is then (AJ9), and only if the view may
 * still write. An upload shows a line under the text until it ends, with
 * a button that cancels it. */
import type { EditorView } from "@codemirror/view";
import {
  UnexpectedAnswer,
  prepareImage,
  uploadAttachment,
} from "../../../lib/src/index.js";
import type { ImageInserter, ImageSlot } from "../../editor/image-insertion.js";
import { t } from "../../i18n/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";

/** What an encryption adds to an image (K-10). */
const OVERHEAD = 28;

export interface ImageUploadEnvironment {
  apiBase: string;
  documentId: string;
  key: CryptoKey;
  roleSecret(): string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The server's limit of an image, in bytes of blobs (`/config.json`). */
  imageBytes: number;
  attached: AttachedImages;
  notify(message: string): void;
  /** Where an upload's line goes. */
  status: HTMLElement;
  /** Asks the user for files: none if they cancel. */
  chooseFiles(): Promise<File[]>;
  /** `prepareImage`, or a test's: WebCrypto doesn't say when it ends. */
  prepare?: typeof prepareImage;
}

/** A file's name as an image's text: its extension and what Markdown
 * would read out of it gone. */
export function altOf(name: string): string {
  const text = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[[\]\\\s]+/g, " ")
    .trim();
  return text || "image";
}

/** Mebibytes, to a tenth, rounded down: never more than the limit. */
function megabytes(bytes: number): number {
  return Math.floor((bytes / (1024 * 1024)) * 10) / 10;
}

export interface ImageUploader extends ImageInserter {
  /** Cancels what is under way; nothing goes in after. */
  destroy(): void;
}

export function createImageUploader(
  env: ImageUploadEnvironment,
): ImageUploader {
  let destroyed = false;
  let queue: Promise<void> = Promise.resolve();
  const controllers = new Set<AbortController>();

  const line = (name: string, cancel: () => void) => {
    const row = document.createElement("div");
    row.className = "image-upload";
    row.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = t().imageUploading(name);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quiet";
    button.textContent = t().imageUploadCancel;
    button.addEventListener("click", cancel);
    row.append(text, button);
    env.status.append(row);
    return row;
  };

  const one = async (view: EditorView, file: File, slot: ImageSlot) => {
    if (destroyed) return;
    if (file.size + OVERHEAD > env.imageBytes) {
      env.notify(
        t().imageTooLarge(file.name, megabytes(env.imageBytes - OVERHEAD)),
      );
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (destroyed) return;
    const prepared = await (env.prepare ?? prepareImage)(
      env.key,
      env.documentId,
      bytes,
    );
    if (destroyed) return;
    if (prepared === "not-an-image")
      return env.notify(t().imageNotAnImage(file.name));
    if (prepared === "malformed")
      return env.notify(t().imageMalformed(file.name));
    const controller = new AbortController();
    controllers.add(controller);
    const row = line(file.name, () => controller.abort());
    let outcome:
      | Awaited<ReturnType<typeof uploadAttachment>>
      | "cancelled"
      | "failed"
      | UnexpectedAnswer;
    try {
      outcome = await uploadAttachment(
        env.apiBase,
        env.documentId,
        prepared.attachmentId,
        env.roleSecret(),
        prepared.blob,
        (url, init) => env.fetch(url, init),
        controller.signal,
      );
    } catch (error) {
      outcome = controller.signal.aborted
        ? "cancelled"
        : error instanceof UnexpectedAnswer
          ? error
          : "failed";
    } finally {
      controllers.delete(controller);
      row.remove();
    }
    if (destroyed || outcome === "cancelled") return;
    if (outcome === "failed")
      return env.notify(t().imageUploadFailed(file.name));
    if (outcome instanceof UnexpectedAnswer)
      return env.notify(t().imageUploadAnswered(file.name, outcome.status));
    // A random identifier taken (W-56): as rare as it is, the server said it.
    if (outcome === "taken")
      return env.notify(t().imageUploadAnswered(file.name, 409));
    if (outcome === "full") return env.notify(t().imageDocumentFull);
    // Under the limit it was checked against: a lower one, the server's
    // (the plugin assumes the default) or a proxy's.
    if (outcome === "too-large")
      return env.notify(t().imageRefusedTooLarge(file.name));
    if (outcome !== "stored") return env.notify(t().imageRefused);
    env.attached.add(prepared.attachmentId, prepared.blob, {
      format: prepared.format,
      bytes: prepared.bytes,
    });
    // Stored: cited where its slot is now, if this view may still write.
    if (view.state.readOnly) return;
    const insert = `![${altOf(file.name)}](attachment:${prepared.attachmentId})`;
    const at = Math.min(slot.pos, view.state.doc.length);
    view.dispatch({
      changes: { from: at, insert },
      userEvent: "input.paste",
    });
  };

  const insert = (
    view: EditorView,
    files: readonly File[],
    slot: ImageSlot,
  ) => {
    const all = [...files];
    queue = queue.then(async () => {
      try {
        for (const file of all) await one(view, file, slot);
      } finally {
        slot.release();
      }
    });
  };

  return {
    insert,
    pick(view, slot) {
      env.chooseFiles().then(
        (files) =>
          files.length > 0 ? insert(view, files, slot) : slot.release(),
        () => slot.release(),
      );
    },
    destroy() {
      destroyed = true;
      for (const controller of controllers) controller.abort();
    },
  };
}
