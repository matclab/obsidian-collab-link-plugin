// The images kept on the device (ADR-0057 §8): a document's own base, its
// blobs as the server gave them — encrypted —, under their identifiers.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import { imageCacheName, openImageCache } from "./image-cache.js";

describe("the images kept on the device", () => {
  test("a blob kept is read back, by its document and identifier", async () => {
    const indexedDB = new IDBFactory();
    const cache = await openImageCache({ indexedDB, documentId: "d" });
    expect(await cache?.get("a")).toBeUndefined();
    await cache?.put("a", Uint8Array.from([1, 2]));
    expect(await cache?.get("a")).toEqual(Uint8Array.from([1, 2]));
    const other = await openImageCache({ indexedDB, documentId: "e" });
    expect(await other?.get("a")).toBeUndefined();
    cache?.close();
    const again = await openImageCache({ indexedDB, documentId: "d" });
    expect(await again?.get("a")).toEqual(Uint8Array.from([1, 2]));
  });

  test("its base is the document's, in a namespace if given; none without IndexedDB", async () => {
    expect(imageCacheName({ documentId: "d" })).toBe("oc:d:images");
    expect(imageCacheName({ documentId: "d", namespace: "v" })).toBe(
      "oc:v:d:images",
    );
    expect(
      await openImageCache({ indexedDB: undefined, documentId: "d" }),
    ).toBeUndefined();
  });

  test("a value that isn't bytes reads as nothing", async () => {
    const indexedDB = new IDBFactory();
    const cache = await openImageCache({ indexedDB, documentId: "d" });
    await cache?.put("a", Uint8Array.from([1]));
    cache?.close();
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("oc:d:images");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const transaction = db.transaction("images", "readwrite");
      transaction.objectStore("images").put("text", "a");
      transaction.oncomplete = resolve;
    });
    db.close();
    const reopened = await openImageCache({ indexedDB, documentId: "d" });
    expect(await reopened?.get("a")).toBeUndefined();
  });
});
