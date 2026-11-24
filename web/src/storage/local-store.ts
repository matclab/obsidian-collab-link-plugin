import { type Role, decrypt, encrypt } from "../../lib/src/index.js";
import { type LocalRecord, decodeRecord, encodeRecord } from "./record.js";

/** An exclusive lock per name, held until the page goes away, or until
 * released (`navigator.locks`; injected, jsdom has none). */
export interface DocumentLock {
  /** Takes the lock if free, for the rest of the page's life. */
  acquire(name: string): Promise<boolean>;
  /** Lets it go: a view that closes while its process lives on (the Obsidian
   * plugin); the page never does. */
  release(name: string): void;
}

/** The Web Locks lock: never released by the page itself — the browser
 * releases it when the page is unloaded or dies (ADR-0022 §5) —; the
 * plugin releases it when a view closes. */
export function webLocks(locks: LockManager): DocumentLock {
  const holding = new Map<string, () => void>();
  return {
    acquire: (name) =>
      new Promise<boolean>((resolve, reject) => {
        locks
          .request(name, { ifAvailable: true }, (lock) => {
            resolve(lock !== null);
            if (!lock) return undefined;
            return new Promise<void>((done) => holding.set(name, done));
          })
          .catch(reject);
      }),
    release(name) {
      holding.get(name)?.();
      holding.delete(name);
    },
  };
}

export type LocalState =
  /** This page holds the lock: it reads and writes the record. */
  | {
      kind: "owner";
      /** What an earlier page stored, if anything. */
      record: LocalRecord | undefined;
      /** Encrypts and writes `record`, replacing the stored one. One at a
       * time (`Saver`), or an older one may land last. */
      save(record: LocalRecord): Promise<void>;
      /** Closes the store and lets the lock go: after the last save. */
      release(): void;
    }
  /** Another tab holds the lock: this one neither reads nor writes. */
  | { kind: "other-tab" }
  /** The stored record doesn't decrypt or decode: left as it is (R-L5). */
  | { kind: "unreadable" }
  /** No IndexedDB or no locks, or IndexedDB refused to open. */
  | { kind: "unavailable" };

/** The base and lock name of a document's record, per role (R-L6); in a
 * namespace when several sets of records share one IndexedDB (the
 * plugin's, one per vault: phase 14, decision 5). */
export function storeName(where: {
  documentId: string;
  role: Role;
  namespace?: string;
}): string {
  const base = `oc:${where.documentId}:${where.role}`;
  return where.namespace ? `oc:${where.namespace}:${base.slice(3)}` : base;
}

const STORE = "record";
const KEY = "record";

/** Opens the document's local record (ADR-0022): takes the lock first, and
 * reads only once it holds it (R-L4). */
export async function openLocalState(options: {
  documentId: string;
  role: Role;
  /** The document's content key: the record is never stored in clear. */
  key: CryptoKey;
  indexedDB?: IDBFactory;
  lock?: DocumentLock;
  /** See `storeName`. */
  namespace?: string;
}): Promise<LocalState> {
  const { key, indexedDB, lock } = options;
  if (!indexedDB || !lock) return { kind: "unavailable" };
  const name = storeName(options);
  let db: IDBDatabase;
  try {
    if (!(await lock.acquire(name))) return { kind: "other-tab" };
    db = await openDatabase(indexedDB, name);
  } catch {
    return { kind: "unavailable" };
  }
  let record: LocalRecord | undefined;
  try {
    const stored = await request<unknown>(
      db.transaction(STORE).objectStore(STORE).get(KEY),
    );
    if (stored !== undefined) {
      if (!ArrayBuffer.isView(stored)) return { kind: "unreadable" };
      record = decodeRecord(await decrypt(key, bytesOf(stored)));
      if (!record) return { kind: "unreadable" };
    }
  } catch {
    return { kind: "unreadable" };
  }
  return {
    kind: "owner",
    record,
    async save(next) {
      const blob = await encrypt(key, encodeRecord(next));
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(blob, KEY);
      await done(transaction);
    },
    release() {
      db.close();
      lock.release(name);
    },
  };
}

/** The document's local record, read without its lock (NT1):
 * for who only reads it, never writes — the round of « Mes documents ».
 * The tab that holds the lock may be writing: a transaction is whole, the
 * old record or the new. Nothing where no copy was kept (no store is made
 * then), nor for one that doesn't decrypt or decode. */
export async function peekLocalRecord(options: {
  documentId: string;
  role: Role;
  key: CryptoKey;
  indexedDB?: IDBFactory;
  namespace?: string;
}): Promise<LocalRecord | undefined> {
  const { key, indexedDB } = options;
  if (!indexedDB) return undefined;
  let db: IDBDatabase;
  try {
    const opening = indexedDB.open(storeName(options));
    // None kept: the opening would make one; abort it.
    opening.onupgradeneeded = () => opening.transaction?.abort();
    db = await request(opening);
  } catch {
    return undefined;
  }
  try {
    if (!db.objectStoreNames.contains(STORE)) return undefined;
    const stored = await request<unknown>(
      db.transaction(STORE).objectStore(STORE).get(KEY),
    );
    if (stored === undefined || !ArrayBuffer.isView(stored)) return undefined;
    return decodeRecord(await decrypt(key, bytesOf(stored))) ?? undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** A plain `Uint8Array` over any view — one of another realm too
 * (`fake-indexeddb` under jsdom). */
function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function openDatabase(indexedDB: IDBFactory, name: string) {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("transaction aborted"));
  });
}
