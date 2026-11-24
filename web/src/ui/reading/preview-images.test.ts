// @vitest-environment jsdom
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnnotationIndex } from "../../../lib/src/annotations/index.js";
import { Presence } from "../../../lib/src/presence/presence.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { attachRemoteCursors } from "../../editor/remote-cursors.js";
import { t } from "../../i18n/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import {
  type RemoteImages,
  createRemoteImages,
} from "../../view-model/remote-images.js";
import { RENDER_DELAY_MS, createPreview } from "./preview.js";

const SRC = "https://img.example/a.png";
const TEXT = `# t\n\nbefore\n\n![a map](${SRC})\n\nafter\n`;

function setUp(text = TEXT) {
  const view = new EditorView({
    doc: text,
    parent: document.createElement("div"),
  });
  const container = document.createElement("div");
  const images = createRemoteImages("doc", undefined);
  const preview = createPreview(container, view, {}, images);
  const sources: string[][] = [];
  preview.onImages((found) => sources.push([...found]));
  const at = (needle: string) =>
    view.dispatch({
      selection: EditorSelection.cursor(
        view.state.doc.toString().indexOf(needle),
      ),
    });
  return { view, container, preview, images, sources, at };
}

const shownImages = (root: Element) =>
  Array.from(root.querySelectorAll("img"), (img) => img.getAttribute("src"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("the preview's remote images (ADR-0055)", () => {
  test("not granted: its link, its domain and a button, nothing loaded (§3)", () => {
    const { container, preview } = setUp();
    preview.show();
    expect(shownImages(container)).toEqual([]);
    const box = container.querySelector(".remote-image-case");
    expect(box?.querySelector("a.remote-image")?.textContent).toBe("a map");
    expect(box?.querySelector(".remote-image-host")?.textContent).toBe(
      "img.example",
    );
    const button = box?.querySelector("button");
    expect(button?.textContent).toBe(t().remoteImageShow);
    expect(button?.getAttribute("aria-label")).toBe(
      t().remoteImageShowLabel("img.example"),
    );
  });

  test("its button grants it: drawn at once, one rendering, its domain under it (§3, §13)", () => {
    const { container, preview } = setUp();
    preview.show();
    resetCounters();
    container
      .querySelector<HTMLButtonElement>(".remote-image-case button")
      ?.click();
    expect(counter("preview.render")).toBe(1);
    expect(shownImages(container)).toEqual([SRC]);
    const img = container.querySelector("img");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.getAttribute("loading")).toBeNull();
    expect(
      container.querySelector(".remote-image-shown .remote-image-from")
        ?.textContent,
    ).toBe(t().remoteImageFrom("img.example"));
  });

  test("granted with the document; taken back: its case again (§4)", () => {
    const { container, preview, images } = setUp();
    preview.show();
    images.grantDocument(false);
    expect(shownImages(container)).toEqual([SRC]);
    images.revoke();
    expect(shownImages(container)).toEqual([]);
    expect(container.querySelector(".remote-image-case button")).not.toBeNull();
  });

  test("hidden, a grant renders nothing", () => {
    const { preview, images } = setUp();
    images.grantDocument(false);
    expect(counter("preview.render")).toBe(0);
    preview.show();
    expect(counter("preview.render")).toBe(1);
  });

  test("under the reader's cursor: waiting, loaded once it leaves, kept when it comes back (§12)", () => {
    const { container, preview, images, at } = setUp();
    at("![a map]");
    preview.show();
    images.grantDocument(false);
    expect(shownImages(container)).toEqual([]);
    const box = container.querySelector(".remote-image-case");
    expect(box?.querySelector(".remote-image-waiting")?.textContent).toBe(
      t().remoteImageWaiting,
    );
    expect(box?.querySelector("button")).toBeNull();
    resetCounters();
    at("after");
    expect(counter("preview.render")).toBe(1);
    expect(shownImages(container)).toEqual([SRC]);
    resetCounters();
    at("![a map]");
    at("before");
    expect(counter("preview.render")).toBe(0);
    expect(shownImages(container)).toEqual([SRC]);
  });

  test("an image by reference waits while the caret is on its definition (§12)", () => {
    const text = `![a map][r]\n\nbetween\n\n[r]: ${SRC}\n\nafter\n`;
    const { container, preview, images, at } = setUp(text);
    at("[r]:");
    preview.show();
    images.grantDocument(false);
    expect(shownImages(container)).toEqual([]);
    expect(container.querySelector(".remote-image-waiting")).not.toBeNull();
    at("after");
    expect(shownImages(container)).toEqual([SRC]);
  });

  test("a cursor moving where no image waits renders nothing", () => {
    const { preview, images, at } = setUp();
    preview.show();
    images.grantDocument(false);
    resetCounters();
    at("before");
    at("after");
    at("![a map]");
    expect(counter("preview.render")).toBe(0);
  });

  test("an address being typed under the cursor is not requested (§12)", () => {
    const { view, container, preview, images } = setUp("x\n\n");
    preview.show();
    images.grantDocument(false);
    for (const piece of ["![m](https://", "img.example/", "a.png)"]) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: piece },
        selection: EditorSelection.cursor(view.state.doc.length + piece.length),
      });
      vi.advanceTimersByTime(RENDER_DELAY_MS);
      expect(shownImages(container)).toEqual([]);
    }
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(shownImages(container)).toEqual([SRC]);
  });

  test("an image that fails to load: its link again (§8)", () => {
    const { container, preview, images } = setUp();
    preview.show();
    images.grantDocument(false);
    container.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(shownImages(container)).toEqual([]);
    expect(container.querySelector("a.remote-image")?.textContent).toBe(
      "a map",
    );
    expect(container.querySelector(".remote-image-case")).toBeNull();
  });

  test("the text's remote images, told after each rendering (§4)", () => {
    const { preview, sources } = setUp();
    preview.show();
    expect(sources.at(-1)).toEqual([SRC]);
  });

  test("hidden, told after a burst, by one parse; none for a keystroke", () => {
    const { view, sources } = setUp("x\n");
    const type = (insert: string) =>
      view.dispatch({ changes: { from: view.state.doc.length, insert } });
    resetCounters();
    type("![m](https://img.example/a.png)");
    type(" more");
    expect(counter("images.scan")).toBe(0);
    vi.advanceTimersByTime(RENDER_DELAY_MS);
    expect(counter("images.scan")).toBe(1);
    expect(counter("preview.render")).toBe(0);
    expect(sources.at(-1)).toEqual([SRC]);
  });
});

describe("another participant's caret (ADR-0055 §12)", () => {
  async function withPresence(text: string) {
    const docA = new LoroDoc();
    docA.getText("content").insert(0, text);
    docA.commit();
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const sent: Uint8Array[] = [];
    const alice = new Presence({
      doc: docA,
      name: () => "alice",
      publish: (bytes) => sent.push(bytes),
    });
    const bob = new Presence({
      doc: docB,
      name: () => "bob",
      publish: () => {},
    });
    const editor = createDocumentEditor(document.createElement("div"), docB);
    attachRemoteCursors(
      editor.view,
      bob,
      new AnnotationIndex(docB, new LoroDoc()),
    );
    const container = document.createElement("div");
    const images = createRemoteImages("doc", undefined);
    const preview = createPreview(container, editor.view, {}, images);
    const deliver = async () => {
      vi.advanceTimersByTime(200);
      for (const bytes of sent.splice(0)) bob.receive(bytes);
      await Promise.resolve();
      await Promise.resolve();
    };
    return { alice, container, preview, images, deliver };
  }

  test("an image waits while another's caret is in its block, then loads", async () => {
    const { alice, container, preview, images, deliver } =
      await withPresence(TEXT);
    alice.setSelection(TEXT.indexOf("map"), TEXT.indexOf("map"));
    await deliver();
    preview.show();
    images.grantDocument(false);
    expect(shownImages(container)).toEqual([]);
    expect(container.querySelector(".remote-image-waiting")).not.toBeNull();
    alice.setSelection(TEXT.indexOf("after"), TEXT.indexOf("after"));
    await deliver();
    expect(shownImages(container)).toEqual([SRC]);
  });
});
