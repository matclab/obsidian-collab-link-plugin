// @vitest-environment jsdom
// A remote image in the formatted text (ADR-0055 §6, §8, §12, §13): drawn
// once granted, without a referrer, its domain under it; never under a
// caret, the reader's or another's; its link again if it fails.
import { forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AnnotationIndex } from "../../lib/src/annotations/index.js";
import { Presence } from "../../lib/src/presence/presence.js";
import { t } from "../i18n/index.js";
import { createRemoteImages } from "../view-model/remote-images.js";
import { createDocumentEditor } from "./editor.js";
import { attachRemoteCursors } from "./remote-cursors.js";
import { attachRemoteImages } from "./remote-image-grants.js";

const SRC = "https://img.example/a.png";
const TEXT = `before\n\n![a map](${SRC})\n\nafter`;

const views: EditorView[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

function setUp(text = TEXT) {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  const parent = document.createElement("div");
  document.body.append(parent);
  const { view } = createDocumentEditor(parent, doc, { livePreview: true });
  views.push(view);
  forceParsing(view, view.state.doc.length, 5000);
  const images = createRemoteImages("doc", undefined);
  attachRemoteImages(view, images);
  const drawn = () =>
    Array.from(view.contentDOM.querySelectorAll("img.cm-live-image"), (img) =>
      img.getAttribute("src"),
    );
  return { doc, view, images, drawn };
}

describe("a remote image in the editor", () => {
  test("not granted: its text, as a link, nothing loaded", () => {
    const { view, drawn } = setUp();
    expect(drawn()).toEqual([]);
    expect(view.contentDOM.querySelector(".cm-live-link")?.textContent).toBe(
      "a map",
    );
  });

  test("not granted: its domain and a button after its text; the button grants it without moving the caret", () => {
    const { view, images, drawn } = setUp();
    const box = view.contentDOM.querySelector(".cm-live-remote-image-case");
    expect(box?.querySelector(".remote-image-host")?.textContent).toBe(
      "img.example",
    );
    const button = box?.querySelector("button");
    expect(button?.textContent).toBe(t().remoteImageShow);
    expect(button?.getAttribute("aria-label")).toBe(
      t().remoteImageShowLabel("img.example"),
    );
    const selection = view.state.selection;
    button?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button?.click();
    expect(images.granted(SRC)).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(drawn()).toEqual([SRC]);
    expect(
      view.contentDOM.querySelector(".cm-live-remote-image-case"),
    ).toBeNull();
  });

  test("no case for an image it may not load", () => {
    const { view } = setUp(
      "![a](http://img.example/a.png)\n\n![b](https://localhost/b.png)",
    );
    expect(
      view.contentDOM.querySelector(".cm-live-remote-image-case"),
    ).toBeNull();
  });

  test("granted: drawn without a referrer, its domain under it", () => {
    const { view, images, drawn } = setUp();
    images.grantDocument(false);
    expect(drawn()).toEqual([SRC]);
    const img =
      view.contentDOM.querySelector<HTMLImageElement>("img.cm-live-image");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.alt).toBe("a map");
    expect(
      view.contentDOM.querySelector(".cm-live-remote-image .remote-image-from")
        ?.textContent,
    ).toBe(t().remoteImageFrom("img.example"));
    images.revoke();
    expect(drawn()).toEqual([]);
  });

  test("never one the page may not load, granted or not", () => {
    const { images, drawn } = setUp(
      "![a](http://img.example/a.png)\n\n![b](https://localhost/b.png)\n\n![c](https://img.example)",
    );
    images.grantDocument(false);
    expect(drawn()).toEqual([]);
  });

  test("under the reader's caret: its source, not drawn", () => {
    const { view, images, drawn } = setUp();
    images.grantDocument(false);
    view.focus();
    view.dispatch({ selection: { anchor: TEXT.indexOf("map") } });
    expect(drawn()).toEqual([]);
    view.dispatch({ selection: { anchor: TEXT.indexOf("after") } });
    expect(drawn()).toEqual([SRC]);
  });

  test("under another's caret: its source, not drawn", async () => {
    const { doc, view, images, drawn } = setUp();
    const other = new LoroDoc();
    other.import(doc.export({ mode: "snapshot" }));
    const sent: Uint8Array[] = [];
    const alice = new Presence({
      doc: other,
      name: () => "alice",
      publish: (bytes) => sent.push(bytes),
    });
    const bob = new Presence({ doc, name: () => "bob", publish: () => {} });
    attachRemoteCursors(view, bob, new AnnotationIndex(doc, new LoroDoc()));
    const deliver = async () => {
      vi.advanceTimersByTime(200);
      for (const bytes of sent.splice(0)) bob.receive(bytes);
      await Promise.resolve();
      await Promise.resolve();
    };
    images.grantDocument(false);
    alice.setSelection(TEXT.indexOf("map"), TEXT.indexOf("map"));
    await deliver();
    expect(drawn()).toEqual([]);
    alice.setSelection(TEXT.indexOf("after"), TEXT.indexOf("after"));
    await deliver();
    expect(drawn()).toEqual([SRC]);
  });

  test("an image that fails to load: its text again", () => {
    const { view, images, drawn } = setUp();
    images.grantDocument(false);
    view.contentDOM
      .querySelector("img.cm-live-image")
      ?.dispatchEvent(new Event("error"));
    expect(images.failed(SRC)).toBe(true);
    expect(drawn()).toEqual([]);
    expect(
      view.contentDOM.querySelector(".cm-live-remote-image-case"),
    ).toBeNull();
    expect(view.contentDOM.querySelector(".cm-live-link")?.textContent).toBe(
      "a map",
    );
  });
});
