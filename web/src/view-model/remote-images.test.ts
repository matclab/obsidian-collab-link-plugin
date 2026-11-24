import { describe, expect, test } from "vitest";
import { REMOTE_IMAGES_KEY, createRemoteImages } from "./remote-images.js";

const A = "https://a.example/1.png";
const B = "https://b.example/2.png";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (at) => [...items.keys()][at] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("createRemoteImages (ADR-0055 §3, §4)", () => {
  test("nothing granted at first", () => {
    const images = createRemoteImages("doc", memoryStorage());
    expect(images.grant).toBe("none");
    expect(images.granted(A)).toBe(false);
  });

  test("one image, for this view only: nothing kept", () => {
    const storage = memoryStorage();
    const images = createRemoteImages("doc", storage);
    images.grantImage(A);
    expect(images.granted(A)).toBe(true);
    expect(images.granted(B)).toBe(false);
    expect(images.grant).toBe("none");
    expect(storage.length).toBe(0);
    expect(createRemoteImages("doc", storage).granted(A)).toBe(false);
  });

  test("the document, for this opening: every image, nothing kept", () => {
    const storage = memoryStorage();
    const images = createRemoteImages("doc", storage);
    images.grantDocument(false);
    expect(images.grant).toBe("opening");
    expect(images.granted(A) && images.granted(B)).toBe(true);
    expect(storage.length).toBe(0);
  });

  test("the document, always: kept on this device for this document only", () => {
    const storage = memoryStorage();
    createRemoteImages("other", storage).grantDocument(true);
    createRemoteImages("doc", storage).grantDocument(true);
    expect(JSON.parse(storage.getItem(REMOTE_IMAGES_KEY) ?? "")).toEqual([
      "other",
      "doc",
    ]);
    const again = createRemoteImages("doc", storage);
    expect(again.grant).toBe("always");
    expect(again.granted(A)).toBe(true);
    expect(createRemoteImages("third", storage).granted(A)).toBe(false);
  });

  test("taken back: no image, the document forgotten, the others kept", () => {
    const storage = memoryStorage();
    createRemoteImages("other", storage).grantDocument(true);
    const images = createRemoteImages("doc", storage);
    images.grantDocument(true);
    images.grantImage(A);
    images.revoke();
    expect(images.grant).toBe("none");
    expect(images.granted(A)).toBe(false);
    expect(createRemoteImages("doc", storage).grant).toBe("none");
    expect(createRemoteImages("other", storage).grant).toBe("always");
  });

  test("an image that failed to load is no longer loaded", () => {
    const images = createRemoteImages("doc", memoryStorage());
    images.grantDocument(false);
    images.markFailed(A);
    expect(images.granted(A)).toBe(false);
    expect(images.failed(A)).toBe(true);
    expect(images.failed(B)).toBe(false);
    expect(images.granted(B)).toBe(true);
  });

  test("each change told, once; a change that changes nothing, not", () => {
    const images = createRemoteImages("doc", memoryStorage());
    let told = 0;
    const stop = images.subscribe(() => told++);
    images.grantImage(A);
    images.grantImage(A);
    images.grantDocument(false);
    images.grantDocument(false);
    images.markFailed(B);
    images.markFailed(B);
    images.revoke();
    expect(told).toBe(4);
    stop();
    images.grantImage(B);
    expect(told).toBe(4);
  });

  test("storage unreadable or refused: granted for this view, as asked", () => {
    const broken = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as Storage;
    const images = createRemoteImages("doc", broken);
    expect(images.grant).toBe("none");
    images.grantDocument(true);
    expect(images.grant).toBe("always");
    expect(images.granted(A)).toBe(true);
    const unparsable = memoryStorage();
    unparsable.setItem(REMOTE_IMAGES_KEY, "{not json");
    expect(createRemoteImages("doc", unparsable).grant).toBe("none");
    expect(createRemoteImages("doc", undefined).grant).toBe("none");
  });
});
