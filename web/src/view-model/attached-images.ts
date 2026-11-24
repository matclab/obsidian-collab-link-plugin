/** The attached images of a view (ADR-0057 §8): each loaded once, from
 * the copy kept on the device or else from the server, decrypted, shown
 * through an address of its own — revoked when the view closes. A state
 * per image, which leaves `loading` once, for good: a failed download is
 * tried again by the next view, never in a loop. Its sources are
 * injected: the page's (`attached-image-sources.ts`), or a test's. */
import type { ImageFormat, OpenedImage } from "../../lib/src/index.js";

export type AttachedState =
  | { kind: "loading" }
  | { kind: "shown"; url: string; format: ImageFormat }
  /** Not on the server (`404`, W-57), or cited by no identifier (D-40). */
  | { kind: "absent" }
  /** Not this image, or of no format of D-40. */
  | { kind: "unreadable" }
  /** The server couldn't be reached, nor a copy found. */
  | { kind: "unavailable" };

/** Where a view's images come from, and how they are shown. */
export interface AttachedImageSources {
  /** The blob kept on this device, if any. */
  cached(id: string): Promise<Uint8Array | undefined>;
  /** Keeps a blob that opened: written once, never awaited by the view. */
  keep(id: string, blob: Uint8Array): Promise<void>;
  /** Rejects when the server can't be reached. */
  download(id: string): Promise<Uint8Array | "absent">;
  open(id: string, blob: Uint8Array): Promise<OpenedImage | "unreadable">;
  url(image: OpenedImage): string;
  revoke(url: string): void;
}

export interface AttachedImages {
  /** The image's state; asked for the first time, it starts loading. */
  state(id: string): AttachedState;
  /** The state, without loading it: for tests. */
  peek(id: string): AttachedState | undefined;
  /** An image this page has just uploaded, shown without a download
   *: its blob is kept too. */
  add(id: string, blob: Uint8Array, image: OpenedImage): void;
  /** The image's bytes, for an export (§8): from the copy kept, else the
   * server; no address made, no state changed. `undefined` if it can't
   * be had. */
  opened(id: string): Promise<OpenedImage | undefined>;
  /** Called with the images whose state changed, at most once a
   * microtask. */
  subscribe(listener: (ids: readonly string[]) => void): () => void;
  /** Revokes every address; what ends after is dropped. */
  close(): void;
}

export function createAttachedImages(
  sources: AttachedImageSources,
): AttachedImages {
  const states = new Map<string, AttachedState>();
  const listeners = new Set<(ids: readonly string[]) => void>();
  let changed = new Set<string>();
  let closed = false;

  const tell = (id: string, state: AttachedState) => {
    if (closed) return;
    states.set(id, state);
    if (changed.size === 0) {
      queueMicrotask(() => {
        const ids = [...changed];
        changed = new Set();
        if (closed) return;
        for (const listener of listeners) listener(ids);
      });
    }
    changed.add(id);
  };

  // Once shown, never an address more: an image added while its download
  // was under way keeps the first.
  const show = (id: string, image: OpenedImage) => {
    if (closed || states.get(id)?.kind === "shown") return;
    tell(id, { kind: "shown", url: sources.url(image), format: image.format });
  };

  const opened = async (id: string, blob: Uint8Array) => {
    const image = await sources.open(id, blob);
    return closed ? "unreadable" : image;
  };

  const load = async (id: string) => {
    try {
      const copy = await sources.cached(id).catch(() => undefined);
      if (closed) return;
      if (copy) {
        const image = await opened(id, copy);
        if (image !== "unreadable") return show(id, image);
      }
      if (closed) return;
      let blob: Uint8Array | "absent";
      try {
        blob = await sources.download(id);
      } catch {
        return tell(id, { kind: "unavailable" });
      }
      if (closed) return;
      if (blob === "absent") return tell(id, { kind: "absent" });
      const image = await opened(id, blob);
      if (image === "unreadable") return tell(id, { kind: "unreadable" });
      show(id, image);
      sources.keep(id, blob).catch(() => {});
    } catch {
      tell(id, { kind: "unreadable" });
    }
  };

  return {
    state(id) {
      if (id === "") return { kind: "absent" };
      const known = states.get(id);
      if (known) return known;
      const loading: AttachedState = { kind: "loading" };
      states.set(id, loading);
      if (!closed) void load(id);
      return loading;
    },
    peek: (id) => states.get(id),
    async opened(id) {
      try {
        const copy = await sources.cached(id).catch(() => undefined);
        if (copy) {
          const image = await sources.open(id, copy);
          if (image !== "unreadable") return image;
        }
        const blob = await sources.download(id);
        if (blob === "absent") return undefined;
        const image = await sources.open(id, blob);
        return image === "unreadable" ? undefined : image;
      } catch {
        return undefined;
      }
    },
    add(id, blob, image) {
      if (closed || states.get(id)?.kind === "shown") return;
      show(id, image);
      sources.keep(id, blob).catch(() => {});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const state of states.values()) {
        if (state.kind === "shown") sources.revoke(state.url);
      }
      listeners.clear();
    },
  };
}
