// @vitest-environment jsdom
// The Révision mode (phase 10d): the open annotations one at a time, in
// the compact sheet; deciding goes on to the next; arrows, a and r.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  createAnnotation,
} from "../../../lib/src/annotations/index.js";
import type { Role } from "../../../lib/src/index.js";
import { attachAnnotationDecorations } from "../../editor/annotation-decorations.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import { createViewSwitch } from "../reading/view-switch.js";
import { createAnnotationsPanel } from "./annotations-panel.js";
import { attachMargin } from "./margin.js";

afterEach(() => document.body.replaceChildren());

function setUp(role: Role = "edit", comment = false) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "one two three four");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  for (const [start, end] of [
    [0, 3],
    [4, 7],
    [8, 13],
  ] as const) {
    createAnnotation(contentDoc, annotationsDoc, {
      type: "deletion",
      start,
      end,
      author: "bob",
    });
  }
  if (comment) {
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 14,
      end: 18,
      author: "bob",
      body: "hm",
    });
  }
  const workspace = document.createElement("main");
  const editorParent = document.createElement("div");
  const panelParent = document.createElement("aside");
  const modes = document.createElement("div");
  workspace.append(editorParent, panelParent);
  document.body.append(modes, workspace);
  const editor = createDocumentEditor(editorParent, contentDoc);
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const active = new ActiveAnnotation();
  attachAnnotationDecorations(editor.view, index, active);
  const published: Uint8Array[] = [];
  const panel = createAnnotationsPanel(
    panelParent,
    editor,
    index,
    () => "alice",
    new LocalDecisions(log, (record) => published.push(record)),
    () => {},
    role,
    active,
  );
  const views = createViewSwitch(
    editorParent,
    editor,
    index,
    role,
    { author: () => "alice", confirm: () => true },
    {},
    modes,
  );
  attachMargin({
    view: editor.view,
    panel,
    index,
    views,
    bar: views.bar,
    workspace,
    // Its view's element: here, the workspace.
    keys: workspace,
    narrow: { matches: () => false, onChange: () => {} },
  });
  const mode = (label: string) =>
    Array.from(modes.querySelectorAll("button"))
      .find((button) => button.textContent?.trim().startsWith(label))
      ?.click();
  const sheet = () => panelParent.querySelector<HTMLElement>(".layout-sheet");
  const shown = () =>
    Array.from(
      sheet()?.querySelectorAll<HTMLElement>(".annotation-item") ?? [],
      (card) => card.dataset.id,
    );
  const key = (k: string, target: EventTarget = workspace) => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
    flushSync();
  };
  const ids = [...index.current().annotations].map((a) => a.id);
  return {
    modes,
    mode,
    sheet,
    shown,
    key,
    ids,
    active,
    published,
    panelParent,
    index,
  };
}

describe("Révision", () => {
  test("its mode says how many annotations are open, and opens the sheet on the first", () => {
    const { modes, mode, sheet, shown, ids } = setUp();
    expect(modes.textContent).toContain("Review");
    expect(modes.querySelector(".mode-count")?.textContent).toBe("3");
    mode("Review");
    flushSync();
    expect(sheet()?.hidden).toBe(false);
    expect(shown()).toEqual([ids[0]]);
    expect(sheet()?.textContent).toContain("1 of 3");
  });

  test("a key outside its view does nothing: another view may share the window", () => {
    const { mode, shown, key, ids, published } = setUp();
    mode("Review");
    flushSync();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    for (const k of ["ArrowRight", "a", "r"]) key(k, elsewhere);
    expect(shown()).toEqual([ids[0]]);
    expect(published).toHaveLength(0);
    key("ArrowRight");
    expect(shown()).toEqual([ids[1]]);
  });

  test("arrows go from one to the next; a decision goes on to the next undecided", () => {
    const { mode, shown, key, ids, published } = setUp();
    mode("Review");
    flushSync();
    key("ArrowRight");
    expect(shown()).toEqual([ids[1]]);
    key("ArrowLeft");
    expect(shown()).toEqual([ids[0]]);
    key("a");
    expect(published).toHaveLength(1);
    expect(shown()).toEqual([ids[1]]);
    key("r");
    expect(published).toHaveLength(2);
    expect(shown()).toEqual([ids[2]]);
    key("a");
    // Every one decided by this page, its decision on its way.
    expect(shown()).toEqual([]);
  });

  test("a decides on the card shown only: it accepts a suggestion, resolves a comment", () => {
    const { mode, key, shown, ids, published } = setUp("edit", true);
    mode("Review");
    flushSync();
    key("ArrowLeft"); // the comment, last
    expect(shown()).toEqual([ids[3]]);
    key("ArrowLeft");
    expect(shown()).toEqual([ids[2]]);
    key("a"); // accepts the last deletion, goes on to the comment
    expect(published).toHaveLength(1);
    expect(shown()).toEqual([ids[3]]);
    key("a"); // resolves the comment
    expect(published).toHaveLength(2);
  });

  // Phase 13b (decision 7): the card shown has its thread and its field;
  // while typing a reply, a, r and the arrows are text.
  test("a reply typed in the card shown: its keys are text, it is sent, the card stays", () => {
    const { mode, shown, ids, published, sheet, index } = setUp();
    mode("Review");
    flushSync();
    sheet()?.querySelector<HTMLButtonElement>(".reply-open")?.click();
    const field = sheet()?.querySelector<HTMLTextAreaElement>(".reply-text");
    if (!field) throw new Error("no reply field in the sheet");
    for (const k of ["a", "r", "ArrowRight"]) {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true }),
      );
    }
    flushSync();
    expect(published).toHaveLength(0);
    expect(shown()).toEqual([ids[0]]);

    field.value = "why?";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    flushSync();
    expect(index.current().byId.get(ids[0] ?? "")?.replies).toMatchObject([
      { author: "alice", body: "why?" },
    ]);
    expect(shown()).toEqual([ids[0]]);
    expect(sheet()?.querySelector(".card-reply .reply-body")?.textContent).toBe(
      "why?",
    );
  });

  test("Escape in the reply field closes the field, not the sheet", () => {
    const { mode, sheet } = setUp();
    mode("Review");
    flushSync();
    sheet()?.querySelector<HTMLButtonElement>(".reply-open")?.click();
    sheet()
      ?.querySelector(".reply-text")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    flushSync();
    expect(sheet()?.querySelector(".reply-text")).toBeNull();
    expect(sheet()?.hidden).toBe(false);
  });

  test("once nothing is left to decide, it says so", () => {
    const { mode, key, sheet } = setUp();
    mode("Review");
    flushSync();
    for (let i = 0; i < 3; i++) key("a");
    expect(sheet()?.textContent).toContain("Nothing left");
  });

  test("a reviewer or a reader goes through them without deciding", () => {
    const { mode, key, shown, ids, published } = setUp("suggest");
    mode("Review");
    flushSync();
    key("a");
    expect(published).toHaveLength(0);
    key("ArrowRight");
    expect(shown()).toEqual([ids[1]]);
  });

  test("leaving it puts the cards back in the margin", () => {
    const { mode, panelParent } = setUp();
    mode("Review");
    flushSync();
    mode("Write");
    flushSync();
    expect(panelParent.querySelector(".layout-margin")).not.toBeNull();
  });
});
