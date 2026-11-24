/** The attached images kept on the device (ADR-0057 §8): their blobs as
 * the server gave them — still encrypted, K-19 —, so that an image seen
 * once shows offline, and in the copy kept after a deletion (ADR-0024).
 * A base of its own per document, beside the record (ADR-0022): written
 * by any tab, an image never changes, so no lock. */

export interface ImageCache {
  get(id: string): Promise<Uint8Array | undefined>;
  put(id: string, blob: Uint8Array): Promise<void>;
  close(): void;
}

const STORE = "images";

/** The base of a document's images; in a namespace as `storeName`. */
export function imageCacheName(where: {
  documentId: string;
  namespace?: string;
}): string {
  return where.namespace
    ? `oc:${where.namespace}:${where.documentId}:images`
    : `oc:${where.documentId}:images`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** `undefined` without IndexedDB, or if it refuses to open. */
export async function openImageCache(options: {
  indexedDB: IDBFactory | undefined;
  documentId: string;
  namespace?: string;
}): Promise<ImageCache | undefined> {
  if (!options.indexedDB) return undefined;
  let db: IDBDatabase;
  try {
    const opening = options.indexedDB.open(imageCacheName(options), 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    db = await request(opening);
  } catch {
    return undefined;
  }
  return {
    async get(id) {
      const stored = await request<unknown>(
        db.transaction(STORE).objectStore(STORE).get(id),
      );
      // A view of another realm too (`fake-indexeddb` under jsdom).
      return ArrayBuffer.isView(stored)
        ? new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength)
        : undefined;
    },
    put(id, blob) {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(blob, id);
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("transaction aborted"));
      });
    },
    close: () => db.close(),
  };
}
