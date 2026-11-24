import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { PageConfig } from "../account/config.js";
import { imageInserter } from "../editor/image-insertion.js";
import { openImageCache } from "../storage/image-cache.js";
import {
  type ObjectUrls,
  attachedImageSources,
} from "../ui/images/attached-image-sources.js";
import { chooseImages } from "../ui/images/choose-images.js";
import {
  type ImageUploader,
  createImageUploader,
} from "../ui/images/image-upload.js";
import {
  type AttachedImages,
  createAttachedImages,
} from "../view-model/attached-images.js";

/** A view's attached images (ADR-0057 §8), under the secret of now;
 * none without the network or object URLs. */
export function viewAttachedImages(options: {
  apiBase: string;
  documentId: string;
  key: CryptoKey;
  roleSecret(): string;
  fetch: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  objectUrls: ObjectUrls | undefined;
  indexedDB: IDBFactory | undefined;
  localNamespace: string | undefined;
}): AttachedImages | undefined {
  const { fetch, objectUrls, localNamespace } = options;
  return fetch && objectUrls
    ? createAttachedImages(
        attachedImageSources({
          apiBase: options.apiBase,
          documentId: options.documentId,
          key: options.key,
          roleSecret: options.roleSecret,
          fetch,
          cache: () =>
            openImageCache({
              indexedDB: options.indexedDB,
              documentId: options.documentId,
              ...(localNamespace && { namespace: localNamespace }),
            }),
          urls: objectUrls,
        }),
      )
    : undefined;
}

/** An editor inserts images (ADR-0057 §8), once the server says it takes
 * them (`limits`); their upload made on first use, never once the view is
 * closed. Its interleavings:
 * IM1, IM2 (`docs/phase-38-refactorisation-de-la-page.md`). */
export function offerImageInsertion(options: {
  limits: Promise<PageConfig["attachments"]>;
  view: EditorView;
  /** Where the uploads' status goes. */
  parent: HTMLElement;
  root: HTMLElement;
  apiBase: string;
  documentId: string;
  key: CryptoKey;
  roleSecret(): string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  attached: AttachedImages;
  notify(message: string): void;
  /** The view's, run as it closes; and whether it has. */
  stops: (() => void)[];
  closed(): boolean;
}): void {
  const { view, root, stops } = options;
  void options.limits.then((limits) => {
    if (!limits || view.state.readOnly || !view.dom.isConnected) return;
    const status = document.createElement("div");
    status.className = "image-uploads";
    options.parent.append(status);
    let uploader: Promise<ImageUploader> | undefined;
    const load = () => {
      uploader ??= Promise.resolve().then(() => {
        const created = createImageUploader({
          apiBase: options.apiBase,
          documentId: options.documentId,
          key: options.key,
          roleSecret: options.roleSecret,
          fetch: options.fetch,
          imageBytes: limits.imageBytes,
          attached: options.attached,
          notify: (message) => options.notify(message),
          status,
          chooseFiles: () => chooseImages(root.ownerDocument),
        });
        stops.push(() => created.destroy());
        return created;
      });
      return uploader;
    };
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        imageInserter.of({
          pick(editor, slot) {
            // In the gesture: a browser refuses a picker opened later.
            // Chosen once the view is closed: nothing made, nothing sent.
            void chooseImages(root.ownerDocument).then((files) =>
              files.length > 0 && !options.closed()
                ? load().then((loaded) => loaded.insert(editor, files, slot))
                : slot.release(),
            );
          },
          insert(editor, files, slot) {
            void load().then((loaded) => loaded.insert(editor, files, slot));
          },
        }),
      ),
    });
  });
}
