/** Where the page's views find attached images (ADR-0057 §8): the copy
 * kept on the device, then the server, under the role's secret of now;
 * decrypted under the document and the image (K-19); shown through an
 * address of their own (§7). */
import {
  MEDIA_TYPES,
  type OpenedImage,
  downloadAttachment,
  openImage,
} from "../../../lib/src/index.js";
import type { ImageCache } from "../../storage/image-cache.js";
import type { AttachedImageSources } from "../../view-model/attached-images.js";

/** `URL.createObjectURL` and its revocation, from the page's
 * environment. */
export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

/** An SVG through a `data:` address, which has an opaque origin and which
 * a page can't navigate to; never `blob:`, which has the page's: opened
 * alone, its scripts would run where the keys are (§7). A raster image
 * through `blob:`, typed from its bytes, never from what the server
 * says. */
export function imageAddress(image: OpenedImage, urls: ObjectUrls): string {
  if (image.format === "svg") {
    let binary = "";
    for (const byte of image.bytes) binary += String.fromCharCode(byte);
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }
  return urls.create(
    new Blob([image.bytes as BlobPart], { type: MEDIA_TYPES[image.format] }),
  );
}

export function attachedImageSources(options: {
  apiBase: string;
  documentId: string;
  key: CryptoKey;
  /** `Role-Secret`, with the secret of now (renewed by a rotation). */
  roleSecret(): string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Opened once, when first asked for; none, nothing kept. */
  cache?: () => Promise<ImageCache | undefined>;
  urls: ObjectUrls;
}): AttachedImageSources {
  const { apiBase, documentId, key, urls } = options;
  let cache: Promise<ImageCache | undefined> | undefined;
  const opened = () => {
    cache ??= options.cache?.() ?? Promise.resolve(undefined);
    return cache;
  };
  return {
    cached: async (id) => (await opened())?.get(id),
    keep: async (id, blob) => (await opened())?.put(id, blob),
    download: (id) =>
      downloadAttachment(
        apiBase,
        documentId,
        id,
        options.roleSecret(),
        (url, init) => options.fetch(url, init),
      ),
    open: (id, blob) => openImage(key, documentId, id, blob),
    url: (image) => imageAddress(image, urls),
    revoke: (url) => {
      if (url.startsWith("blob:")) urls.revoke(url);
    },
  };
}
