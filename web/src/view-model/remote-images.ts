// What the reader has granted of a document's remote images (ADR-0055
// §1, §3, §4): local to the device, never written in the document.

/** The documents whose remote images this device always loads (§4): a
 * preference, a list of document ids under one key. */
export const REMOTE_IMAGES_KEY = "obsidian-collab:remote-images";

/** The document's grant: none (image by image), this opening, always. */
export type DocumentGrant = "none" | "opening" | "always";

export interface RemoteImages {
  readonly grant: DocumentGrant;
  /** Whether the image at `src` (normalized, `loadableImageSource`) is
   * loaded: granted, by itself or with the document, and not failed. */
  granted(src: string): boolean;
  /** This image, while the view is open (§3). */
  grantImage(src: string): void;
  /** Every image of the document: for this opening, or always (§4). */
  grantDocument(always: boolean): void;
  /** No more images: the document forgotten, each image too (§4). */
  revoke(): void;
  /** It did not load: its link again (§8). */
  markFailed(src: string): void;
  failed(src: string): boolean;
  /** Told after each change. Returns a stop. */
  subscribe(listener: () => void): () => void;
}

function storedDocuments(storage: Storage | undefined): string[] {
  try {
    const kept: unknown = JSON.parse(
      storage?.getItem(REMOTE_IMAGES_KEY) ?? "[]",
    );
    return Array.isArray(kept)
      ? kept.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function storeDocuments(storage: Storage | undefined, ids: string[]): void {
  try {
    if (ids.length === 0) storage?.removeItem(REMOTE_IMAGES_KEY);
    else storage?.setItem(REMOTE_IMAGES_KEY, JSON.stringify(ids));
  } catch {
    // Kept for this view only.
  }
}

export function createRemoteImages(
  documentId: string,
  storage: Storage | undefined,
): RemoteImages {
  let grant: DocumentGrant = storedDocuments(storage).includes(documentId)
    ? "always"
    : "none";
  const images = new Set<string>();
  const failed = new Set<string>();
  const listeners = new Set<() => void>();
  const told = () => {
    for (const listener of [...listeners]) listener();
  };
  const keep = (always: boolean) => {
    const others = storedDocuments(storage).filter((id) => id !== documentId);
    storeDocuments(storage, always ? [...others, documentId] : others);
  };
  return {
    get grant() {
      return grant;
    },
    granted: (src) => !failed.has(src) && (grant !== "none" || images.has(src)),
    grantImage(src) {
      if (images.has(src)) return;
      images.add(src);
      told();
    },
    grantDocument(always) {
      const next = always ? "always" : "opening";
      if (grant === next) return;
      grant = next;
      if (always) keep(true);
      told();
    },
    revoke() {
      if (grant === "none" && images.size === 0) return;
      if (grant === "always") keep(false);
      grant = "none";
      images.clear();
      told();
    },
    failed: (src) => failed.has(src),
    markFailed(src) {
      if (failed.has(src)) return;
      failed.add(src);
      told();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
