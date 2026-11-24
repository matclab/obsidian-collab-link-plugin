// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  createAnnotation,
  encodeProposal,
  resolveAnnotation,
  suggestAddition,
} from "../../lib/src/annotations/index.js";
import type { Role } from "../../lib/src/crypto/index.js";
import { withoutLayout } from "../editor/test-support/no-layout.js";
import { obsidianDrawing } from "../editor/test-support/obsidian-like.js";
import { wireClient } from "./wire-client.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A document with an open deletion and an open addition, and a client
 * of `role` wired on copies of it. */
async function setUp(role: Role) {
  const source = { content: new LoroDoc(), annotations: new LoroDoc() };
  source.content.getText("content").insert(0, "hello world");
  source.content.commit();
  const deletion = createAnnotation(source.content, source.annotations, {
    type: "deletion",
    start: 0,
    end: 6,
    author: "bob",
  });
  const addition = suggestAddition(source.content, source.annotations, {
    at: 11,
    text: "!",
    author: "bob",
  });
  const change = resolveAnnotation(
    source.content,
    source.annotations,
    addition,
  )?.change;
  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  contentDoc.import(source.content.export({ mode: "update" }));
  annotationsDoc.import(source.annotations.export({ mode: "update" }));
  const adopted: Uint8Array[] = [];
  const client = wireClient({
    contentDoc,
    annotationsDoc,
    editorParent: document.createElement("div"),
    panelParent: document.createElement("div"),
    author: () => "alice",
    documentId: "doc",
    publishDecision: () => {},
    role,
    adopt: (bytes) => adopted.push(bytes),
  });
  client.confirm(
    [
      { annotationId: deletion, decision: "accept" as const },
      { annotationId: addition, decision: "accept" as const, change },
    ].map((proposal, i) => ({
      seq: i + 1,
      record: encodeProposal({
        proposalId: `p${i}`,
        author: "carol",
        ...proposal,
      }),
    })),
  );
  await tick();
  return {
    text: () => contentDoc.getText("content").toString(),
    adopted,
  };
}

describe("who applies decisions (docs/phase-5-modele-acces.md, decision 2)", () => {
  test("an editor applies them, and adopts the change it imports", async () => {
    const { text, adopted } = await setUp("edit");

    expect(text()).toBe("world!");
    expect(adopted).toHaveLength(1);
  });

  test.each(["read", "suggest"] as const)(
    "a %s link applies nothing: it may not publish the result",
    async (role) => {
      const { text, adopted } = await setUp(role);

      expect(text()).toBe("hello world");
      expect(adopted).toEqual([]);
    },
  );
});

// An empty document says where to start (phase 20d): the / menu and the
// help, for who writes; nothing to do, for a reader.
test("an empty document's invite names the / menu and the help, for an editor", () => {
  const invite = (role: Role) => {
    const editorParent = document.createElement("div");
    wireClient({
      contentDoc: new LoroDoc(),
      annotationsDoc: new LoroDoc(),
      editorParent,
      panelParent: document.createElement("div"),
      author: () => "alice",
      documentId: "doc",
      publishDecision: () => {},
      role,
    });
    return editorParent.querySelector(".cm-placeholder")?.textContent ?? "";
  };
  expect(invite("edit")).toContain("/");
  expect(invite("edit")).toContain("?");
  expect(invite("read")).toBe("This document is empty.");
});

// In the plugin, Obsidian draws a callout as a block, its text out of
// sight (choice/obsidian/blocks): a card chosen puts the caret in it, the
// editor focused, so that Obsidian shows its source and the marks.
describe("a card chosen whose passage is in a block the editor draws", () => {
  const TEXT = "Avant.\n\n> [!note] Titre\n> Le contenu.\n\nAprès.";
  const CALLOUT = { from: TEXT.indexOf(">"), to: TEXT.indexOf("\n\nAprès") };
  // The passage comes into view: CodeMirror measures.
  const destroyed = withoutLayout();

  function setUpDrawn(needle: string) {
    const contentDoc = new LoroDoc();
    contentDoc.getText("content").insert(0, TEXT);
    contentDoc.commit();
    const annotationsDoc = new LoroDoc();
    const start = TEXT.indexOf(needle);
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end: start + needle.length,
      author: "bob",
      body: "Ici ?",
    });
    const editorParent = document.createElement("div");
    const panelParent = document.createElement("div");
    document.body.append(editorParent, panelParent);
    const client = wireClient({
      contentDoc,
      annotationsDoc,
      editorParent,
      panelParent,
      author: () => "alice",
      documentId: "doc",
      publishDecision: () => {},
      role: "suggest",
      editor: obsidianDrawing(CALLOUT.from, CALLOUT.to),
    });
    const view = client.editor.view;
    destroyed(view);
    return {
      view,
      start,
      choose: () =>
        panelParent.querySelector<HTMLElement>(".card-head")?.click(),
      done: () => {
        editorParent.remove();
        panelParent.remove();
      },
    };
  }

  test("the caret goes to the passage, the editor focused", () => {
    const { view, start, choose, done } = setUpDrawn("contenu");
    choose();
    expect(view.state.selection.main.head).toBe(start);
    expect(view.hasFocus).toBe(true);
    done();
  });

  // The one card left in Review (docs/bugs.md): ‹ ›, or a click on it,
  // choose the card already active.
  test("the card chosen again: its passage comes back, wherever the caret went", () => {
    const { view, start, choose, done } = setUpDrawn("contenu");
    choose();
    view.dispatch({ selection: { anchor: 0 } });
    choose();
    expect(view.state.selection.main.head).toBe(start);
    done();
  });

  test("a passage in the text: the caret stays where it was", () => {
    const { view, choose, done } = setUpDrawn("Après");
    choose();
    expect(view.state.selection.main.head).toBe(0);
    expect(view.hasFocus).toBe(false);
    done();
  });
});

// An editor in Review suggests at the caret alone, as a reviewer does
// (phase 24): the selection toolbar follows the page's mode.
describe("the selection toolbar in Review", () => {
  const destroyed = withoutLayout();

  test("an editor's caret alone offers Suggest there, not in Write", () => {
    const contentDoc = new LoroDoc();
    contentDoc.getText("content").insert(0, "hello world");
    contentDoc.commit();
    const editorParent = document.createElement("div");
    document.body.append(editorParent);
    const client = wireClient({
      contentDoc,
      annotationsDoc: new LoroDoc(),
      editorParent,
      panelParent: document.createElement("div"),
      author: () => "alice",
      documentId: "doc",
      publishDecision: () => {},
      role: "edit",
    });
    const view = client.editor.view;
    destroyed(view);
    const shown = () =>
      editorParent.querySelector(".selection-toolbar:not([hidden])")
        ?.textContent ?? "";
    const caret = (at: number) => {
      view.focus();
      view.dispatch({ selection: { anchor: at } });
      flushSync();
    };
    const mode = (label: string) => {
      Array.from(document.querySelectorAll<HTMLButtonElement>(".modes button"))
        .find((button) => button.textContent?.trim().startsWith(label))
        ?.click();
      flushSync();
    };

    caret(5);
    expect(shown()).toBe("");
    mode("Review");
    caret(6);
    expect(shown()).toContain("Suggest");
    mode("Write");
    expect(shown()).toBe("");
    editorParent.remove();
  });
});
