import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import { generateKey } from "../../lib/src/crypto/aead.js";
import {
  type LocalState,
  openLocalState,
  peekLocalRecord,
  storeName,
  webLocks,
} from "./local-store.js";
import { FakeLocks } from "./test-support/fake-locks.js";
import { sample } from "./test-support/sample.js";

async function owner(state: LocalState) {
  if (state.kind !== "owner") throw new Error(`not the owner: ${state.kind}`);
  return state;
}

async function rawValues(idb: IDBFactory, name: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const store = db.transaction("record").objectStore("record");
  return new Promise((resolve) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
  });
}

describe("openLocalState", () => {
  const where = { documentId: "doc-1", role: "edit" as const };

  test("a first page owns an empty store; what it saves, the next page reads", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();

    const first = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    expect(first.record).toBeUndefined();
    await first.save(sample);

    locks.release(storeName(where)); // the first page is gone
    const next = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    expect(next.record).toEqual(sample);
  });

  // A view that closes while its process lives on (the Obsidian plugin,
  // phase 14, decision 17) releases the lock itself.
  test("an owner that releases: the next owns, and reads what it saved", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();

    const first = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    await first.save(sample);
    first.release();

    const next = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    expect(next.record).toEqual(sample);
  });

  // The plugin's IndexedDB is the same for every vault (decision 5).
  test("in two namespaces, the same document's records are apart", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    const open = (namespace: string) =>
      openLocalState({ ...where, namespace, key, indexedDB, lock: locks });

    const one = await owner(await open("vault-one"));
    const two = await owner(await open("vault-two"));
    await one.save(sample);
    one.release();
    two.release();

    expect((await owner(await open("vault-two"))).record).toBeUndefined();
    expect((await owner(await open("vault-one"))).record).toEqual(sample);
  });

  test("stored encrypted: the snapshot's bytes are nowhere in clear", async () => {
    const indexedDB = new IDBFactory();
    const key = await generateKey();
    const marker = new TextEncoder().encode("a secret sentence of the doc");
    const record = structuredClone(sample);
    const [content] = record.channels;
    if (content) content.snapshot = marker;

    const state = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: new FakeLocks() }),
    );
    await state.save(record);

    const values = await rawValues(indexedDB, storeName(where));
    expect(values).toHaveLength(1);
    const stored = Buffer.from(values[0] as Uint8Array);
    expect(stored.includes(Buffer.from(marker))).toBe(false);
  });

  test("while another tab holds the lock: not the owner, and nothing read (R-L4)", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    const first = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    await first.save(sample);

    const second = await openLocalState({
      ...where,
      key,
      indexedDB,
      lock: locks,
    });
    expect(second).toEqual({ kind: "other-tab" });
  });

  test("a record that doesn't decrypt: not the owner, and left as it is (R-L5)", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    await (
      await owner(
        await openLocalState({ ...where, key, indexedDB, lock: locks }),
      )
    ).save(sample);
    locks.release(storeName(where));

    const otherKey = await generateKey();
    const other = await openLocalState({
      ...where,
      key: otherKey,
      indexedDB,
      lock: locks,
    });
    expect(other).toEqual({ kind: "unreadable" });

    locks.release(storeName(where));
    const again = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    expect(again.record).toEqual(sample);
  });

  test("one record per document and per role (R-L6)", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    await (
      await owner(
        await openLocalState({ ...where, key, indexedDB, lock: locks }),
      )
    ).save(sample);

    const review = await owner(
      await openLocalState({
        documentId: "doc-1",
        role: "suggest",
        key,
        indexedDB,
        lock: locks,
      }),
    );
    expect(review.record).toBeUndefined();
    const otherDocument = await owner(
      await openLocalState({
        documentId: "doc-2",
        role: "edit",
        key,
        indexedDB,
        lock: locks,
      }),
    );
    expect(otherDocument.record).toBeUndefined();
  });

  test("no IndexedDB or no locks in this browser: unavailable", async () => {
    const key = await generateKey();
    expect(
      await openLocalState({ ...where, key, lock: new FakeLocks() }),
    ).toEqual({ kind: "unavailable" });
    expect(
      await openLocalState({ ...where, key, indexedDB: new IDBFactory() }),
    ).toEqual({ kind: "unavailable" });
  });

  test("IndexedDB refusing to open: unavailable", async () => {
    const key = await generateKey();
    const broken = {
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory;
    expect(
      await openLocalState({
        ...where,
        key,
        indexedDB: broken,
        lock: new FakeLocks(),
      }),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("webLocks", () => {
  /** The part of `LockManager` it uses: grants `name` to one holder, until
   * the promise its callback returned settles. */
  function fakeManager() {
    const held = new Set<string>();
    return {
      held,
      request(
        name: string,
        _options: { ifAvailable: true },
        callback: (lock: object | null) => Promise<unknown> | undefined,
      ): Promise<unknown> {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        const holding = callback({}) ?? Promise.resolve();
        return holding.finally(() => held.delete(name));
      },
    };
  }

  test("takes a free lock and keeps it; a taken one is refused", async () => {
    const manager = fakeManager();
    const lock = webLocks(manager as unknown as LockManager);
    expect(await lock.acquire("oc:doc-1:edit")).toBe(true);
    // Every microtask run: the fake manager holds in them only.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.held.has("oc:doc-1:edit")).toBe(true); // never released
    expect(await lock.acquire("oc:doc-1:edit")).toBe(false);
    expect(await lock.acquire("oc:doc-1:suggest")).toBe(true);
  });

  test("released, the lock is free for the next holder", async () => {
    const manager = fakeManager();
    const lock = webLocks(manager as unknown as LockManager);
    expect(await lock.acquire("oc:doc-1:edit")).toBe(true);
    lock.release("oc:doc-1:edit");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.held.has("oc:doc-1:edit")).toBe(false);
    expect(await lock.acquire("oc:doc-1:edit")).toBe(true);
  });
});

// The round of « Mes documents » (phase 34, NT1): it reads a copy without
// its lock, never writes, and makes no store where there was none.
describe("peekLocalRecord", () => {
  const where = { documentId: "doc-1", role: "edit" as const };

  test("reads what the owner saved, while the owner holds the lock", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    const first = await owner(
      await openLocalState({ ...where, key, indexedDB, lock: locks }),
    );
    await first.save(sample);
    expect(await peekLocalRecord({ ...where, key, indexedDB })).toEqual(sample);
    // The owner keeps its lock and its store: it saves again.
    await first.save(sample);
  });

  test("nothing where no copy was kept, and no store made", async () => {
    const indexedDB = new IDBFactory();
    const key = await generateKey();
    expect(await peekLocalRecord({ ...where, key, indexedDB })).toBeUndefined();
    const names = (await indexedDB.databases()).map((db) => db.name);
    expect(names).not.toContain(storeName(where));
  });

  test("nothing for a copy that doesn't decrypt", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const first = await owner(
      await openLocalState({
        ...where,
        key: await generateKey(),
        indexedDB,
        lock: locks,
      }),
    );
    await first.save(sample);
    expect(
      await peekLocalRecord({ ...where, key: await generateKey(), indexedDB }),
    ).toBeUndefined();
  });

  test("the lock stays free for a tab that opens the document after", async () => {
    const indexedDB = new IDBFactory();
    const locks = new FakeLocks();
    const key = await generateKey();
    await peekLocalRecord({ ...where, key, indexedDB });
    expect(
      (await openLocalState({ ...where, key, indexedDB, lock: locks })).kind,
    ).toBe("owner");
  });
});
