// @vitest-environment jsdom
// What the editor's other layers keep in sight of the formatted text
// (phase 11e; analysis 11a.1, points 2 and 3; decision 7): a proposal or
// a remote caret in a link's address reveals its line, the active passage
// is revealed, a table holding an annotation stays its source.
import { forceParsing } from "@codemirror/language";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AnnotationIndex,
  type AnnotationType,
  tryCreateAnnotation,
} from "../../lib/src/annotations/index.js";
import { Presence } from "../../lib/src/presence/presence.js";
import { countDuring } from "../perf/index.js";
import { ActiveAnnotation } from "../view-model/active-annotation.js";
import { attachAnnotationDecorations } from "./annotation-decorations.js";
import { createDocumentEditor } from "./editor.js";
import { attachRemoteCursors } from "./remote-cursors.js";

const LINK = 'Un [lien](https://example.org "t").\n\nDu **gras**.';
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

const parents: Element[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  for (const parent of parents.splice(0)) parent.remove();
});

function setUp(text: string) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const parent = document.createElement("div");
  document.body.append(parent);
  parents.push(parent);
  const editor = createDocumentEditor(parent, contentDoc, {
    livePreview: true,
  });
  forceParsing(editor.view, editor.view.state.doc.length, 5000);
  const index = new AnnotationIndex(contentDoc, annotationsDoc);
  const active = new ActiveAnnotation();
  attachAnnotationDecorations(editor.view, index, active);
  const annotate = async (
    type: AnnotationType,
    needle: string,
    extra: { replacement?: string; body?: string } = {},
  ) => {
    const start = text.indexOf(needle);
    const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type,
      start,
      end: start + needle.length,
      author: "bob",
      ...extra,
    });
    if (!created.ok) throw new Error("not created");
    await Promise.resolve(); // the index notifies once per microtask
    return created.id;
  };
  const shown = () =>
    Array.from(
      editor.view.contentDOM.querySelectorAll(".cm-line"),
      (line) => line.textContent,
    );
  return { contentDoc, editor, index, active, annotate, shown };
}

describe("live formatting keeps in sight", () => {
  test("a suggestion in a link's address: its line as source, the proposal shown", async () => {
    const { annotate, shown } = setUp(LINK);
    expect(shown()[0]).toBe("Un lien.");
    await annotate("substitution", "org", { replacement: "com" });
    expect(shown()).toEqual([
      'Un [lien](https://example.orgcom "t").',
      "",
      "Du gras.",
    ]);
  });

  test("a comment on shown text leaves its line formatted", async () => {
    const { annotate, shown } = setUp(LINK);
    await annotate("comment", "lien", { body: "?" });
    expect(shown()[0]).toBe("Un lien.");
  });

  test("the active passage revealed without focus, formatted again once not", async () => {
    const { annotate, active, shown, editor } = setUp(LINK);
    const id = await annotate("comment", "gras", { body: "?" });
    expect(editor.view.hasFocus).toBe(false);
    expect(shown()[2]).toBe("Du gras.");
    active.set(id, "card");
    expect(shown()[2]).toBe("Du **gras**.");
    active.set(undefined, "card");
    expect(shown()[2]).toBe("Du gras.");
  });

  test("choosing the active annotation computes the formatting once", async () => {
    const { annotate, active } = setUp(LINK);
    const id = await annotate("comment", "gras", { body: "?" });
    expect(countDuring("live.build", () => active.set(id, "card"))).toBe(1);
  });

  test("a table holding an annotation stays its source (decision 7)", async () => {
    const text = `Avant.\n\n${TABLE}\n\nAprès.`;
    const { annotate, editor } = setUp(text);
    const tables = () =>
      editor.view.contentDOM.querySelectorAll(".cm-live-table").length;
    expect(tables()).toBe(1);
    await annotate("deletion", "2");
    expect(tables()).toBe(0);
    expect(editor.view.contentDOM.textContent).toContain("| 1 | 2 |");
  });

  test("a remote caret in a link's address reveals its line", async () => {
    const { contentDoc, editor, index, shown } = setUp(LINK);
    const peer = new LoroDoc();
    peer.import(contentDoc.export({ mode: "snapshot" }));
    const sent: Uint8Array[] = [];
    const alice = new Presence({
      doc: peer,
      name: () => "alice",
      publish: (bytes) => sent.push(bytes),
    });
    const bob = new Presence({
      doc: contentDoc,
      name: () => "bob",
      publish: () => {},
    });
    attachRemoteCursors(editor.view, bob, index);
    const at = LINK.indexOf("example");
    alice.setSelection(at, at);
    vi.advanceTimersByTime(200);
    for (const bytes of sent.splice(0)) bob.receive(bytes);
    await Promise.resolve();
    await Promise.resolve();
    expect(shown()[0]).toBe('Un [lien](https://aliceexample.org "t").');
  });

  test("a keystroke reads only the annotations on screen: none more for four times as many", async () => {
    const readFor = async (n: number) => {
      const text = Array.from(
        { length: n },
        (_, i) => `Ligne ${i} [lien](https://x${i}.org).`,
      ).join("\n\n");
      const contentDoc = new LoroDoc();
      contentDoc.getText("content").insert(0, text);
      contentDoc.commit();
      const annotationsDoc = new LoroDoc();
      for (let i = 0; i < n; i++) {
        const start = text.indexOf(`x${i}.org`);
        tryCreateAnnotation(contentDoc, annotationsDoc, {
          type: "comment",
          start,
          end: start + 2,
          author: "bob",
          body: "?",
        });
      }
      const parent = document.createElement("div");
      document.body.append(parent);
      parents.push(parent);
      const editor = createDocumentEditor(parent, contentDoc, {
        livePreview: true,
      });
      forceParsing(editor.view, editor.view.state.doc.length, 5000);
      attachAnnotationDecorations(
        editor.view,
        new AnnotationIndex(contentDoc, annotationsDoc),
      );
      await Promise.resolve();
      return countDuring("live.reveal", () =>
        editor.view.dispatch({
          changes: { from: 0, insert: "k" },
          userEvent: "input.type",
        }),
      );
    };
    const few = await readFor(60);
    expect(few).toBeGreaterThan(0);
    expect(await readFor(240)).toBe(few);
  }, 60_000); // 300 annotations created: slow on a loaded machine
});
