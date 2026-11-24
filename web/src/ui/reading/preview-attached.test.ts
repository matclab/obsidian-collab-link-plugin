// @vitest-environment jsdom
//
// Attached images in the preview (ADR-0057 §8): one known shows at once;
// one that arrives fills its slot alone, without a rendering more
// (AGENTS.md §6); one that can't be shown keeps its text, with why; a
// block kept by an edit elsewhere keeps its image; a typed character
// asks nothing of the images.
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { t } from "../../i18n/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import type {
  AttachedImages,
  AttachedState,
} from "../../view-model/attached-images.js";
import { createPreview } from "./preview.js";

const A = "AAECAwQFBgcICQoLDA0ODw";
const B = "AQECAwQFBgcICQoLDA0ODw";

/** The view's images, as the test makes them change. */
function images(initial: Record<string, AttachedState>) {
  const states = new Map(Object.entries(initial));
  const listeners: ((ids: readonly string[]) => void)[] = [];
  const asked: string[] = [];
  const service: AttachedImages = {
    state(id) {
      asked.push(id);
      if (id === "") return { kind: "absent" };
      return states.get(id) ?? { kind: "loading" };
    },
    peek: (id) => states.get(id),
    add() {},
    opened: async () => undefined,
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    close() {},
  };
  const arrive = (id: string, state: AttachedState) => {
    states.set(id, state);
    for (const listener of listeners) listener([id]);
  };
  return { service, arrive, asked };
}

function setUp(text: string, attached: AttachedImages) {
  const view = new EditorView({
    doc: text,
    parent: document.createElement("div"),
  });
  const container = document.createElement("div");
  const preview = createPreview(container, view, {}, undefined, attached);
  preview.show();
  const type = (insert: string) =>
    view.dispatch({ changes: { from: view.state.doc.length, insert } });
  return { view, preview, type };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("attached images in the preview", () => {
  test("one known shows at once, its text its alternative", () => {
    const { service } = images({
      [A]: { kind: "shown", url: "blob:x/1", format: "png" },
    });
    const { preview } = setUp(`![a dog](attachment:${A})`, service);
    const image = preview.root.querySelector(".attached-image img");
    expect(image?.getAttribute("src")).toBe("blob:x/1");
    expect(image?.getAttribute("alt")).toBe("a dog");
  });

  test("one that arrives fills its slot alone, never a rendering more", () => {
    const { service, arrive } = images({});
    const { preview } = setUp(
      `![a](attachment:${A})\n\n![b](attachment:${B})`,
      service,
    );
    const slot = (id: string) =>
      preview.root.querySelector<HTMLElement>(`[data-attachment="${id}"]`);
    expect(slot(A)?.textContent).toContain(t().attachedImageLoading);
    expect(slot(A)?.querySelector("img")).toBeNull();
    const renders = counter("preview.render");
    const fills = counter("preview.attached-image");

    arrive(A, { kind: "shown", url: "blob:x/a", format: "png" });

    expect(slot(A)?.querySelector("img")?.getAttribute("src")).toBe("blob:x/a");
    expect(slot(B)?.textContent).toContain(t().attachedImageLoading);
    expect(counter("preview.render")).toBe(renders);
    expect(counter("preview.attached-image") - fills).toBe(1);
  });

  test("one that can't be shown keeps its text, and says why", () => {
    for (const [kind, text] of [
      ["absent", t().attachedImageAbsent],
      ["unreadable", t().attachedImageUnreadable],
      ["unavailable", t().attachedImageUnavailable],
    ] as const) {
      const { service } = images({ [A]: { kind } });
      const { preview } = setUp(`![a dog](attachment:${A})`, service);
      const slot = preview.root.querySelector(".attached-image");
      expect(slot?.textContent, kind).toBe(`a dog${text}`);
      expect(slot?.querySelector("img")).toBeNull();
    }
    // An identifier that cites nothing (D-40).
    const { service } = images({});
    const { preview } = setUp("![x](attachment:nothing)", service);
    expect(preview.root.textContent).toBe(`x${t().attachedImageAbsent}`);
  });

  test("an edit elsewhere keeps the image's block, and asks nothing", () => {
    const { service, asked } = images({
      [A]: { kind: "shown", url: "blob:x/1", format: "png" },
    });
    const { preview, type } = setUp(`![a](attachment:${A})\n\ntext`, service);
    const image = preview.root.querySelector("img");
    asked.length = 0;
    type(" more");
    vi.advanceTimersByTime(1000);
    expect(preview.root.querySelector("img")).toBe(image);
    expect(asked, "a drawn slot is not filled again").toEqual([]);
  });
});
