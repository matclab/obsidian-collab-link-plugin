// @vitest-environment jsdom
//
// What awaits my reply, in the interface (ADR-0050 §4, §5; phase 23e): a
// mark on the card, « Nothing to add » and « Put back »; the count and
// ‹ › beside the modes, in the text's order, F8; the review's walk of
// what awaits me, which goes on after a reply or a setting aside; nothing
// for a reader.
import { LoroDoc } from "loro-crdt";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  createAnnotation,
  replyToAnnotation,
} from "../../../lib/src/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { ActiveAnnotation } from "../../view-model/active-annotation.js";
import { AwaitingIndex } from "../../view-model/awaiting-index.js";
import { PageMe } from "../../view-model/page-me.js";
import { SetAside } from "../../view-model/set-aside.js";
import { createAnnotationsPanel } from "./annotations-panel.js";
import { attachAwaitingNav } from "./awaiting-nav.js";

function setUp(role: "read" | "suggest" | "edit" = "suggest") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "one two three four five");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const decisions = new LocalDecisions(log, () => {});
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const panelParent = document.createElement("div");
  const header = document.createElement("div");
  const keys = document.createElement("div");
  document.body.append(panelParent, header, keys);
  const me = new PageMe("Alice");
  const setAside = new SetAside();
  const active = new ActiveAnnotation();
  const awaiting = new AwaitingIndex({
    annotations: index,
    decisions,
    me,
    setAside,
    role,
  });
  const panel = createAnnotationsPanel(
    panelParent,
    editor,
    index,
    () => "Alice",
    decisions,
    () => {},
    role,
    active,
    undefined,
    undefined,
    undefined,
    { index: awaiting, setAside },
  );
  const nav =
    role === "read"
      ? undefined
      : attachAwaitingNav(header, { awaiting, index, active, keys });
  const comment = (start: number, author: string) =>
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end: start + 3,
      author,
      body: "?",
    });
  const card = (id: string) =>
    panelParent.querySelector<HTMLElement>(`.annotation-item[data-id="${id}"]`);
  const settle = async () => {
    // Every microtask run, however long its chain: a macrotask comes after.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
  };
  return {
    annotationsDoc,
    panel,
    panelParent,
    header,
    keys,
    active,
    setAside,
    nav,
    comment,
    card,
    settle,
  };
}

describe("on the cards", () => {
  test("another's comment is marked; mine isn't; a reply of mine takes the mark away", async () => {
    const s = setUp();
    const theirs = s.comment(0, "Bob");
    const mine = s.comment(8, "Alice");
    await s.settle();
    expect(s.card(theirs)?.querySelector(".awaiting-mark")).not.toBeNull();
    expect(s.card(mine)?.querySelector(".awaiting-mark")).toBeNull();
    replyToAnnotation(s.annotationsDoc, theirs, {
      author: "Alice",
      body: "ok",
    });
    await s.settle();
    expect(s.card(theirs)?.querySelector(".awaiting-mark")).toBeNull();
  });

  test("« Nothing to add » sets it aside, « Put back » brings it back", async () => {
    const s = setUp();
    const id = s.comment(0, "Bob");
    await s.settle();
    s.card(id)?.querySelector<HTMLButtonElement>(".set-aside")?.click();
    await s.settle();
    expect(s.card(id)?.querySelector(".awaiting-mark")).toBeNull();
    expect(s.setAside.get(id)).toBe(id);
    s.card(id)?.querySelector<HTMLButtonElement>(".put-back")?.click();
    await s.settle();
    expect(s.card(id)?.querySelector(".awaiting-mark")).not.toBeNull();
    // Another's reply after setting aside: marked again.
    s.card(id)?.querySelector<HTMLButtonElement>(".set-aside")?.click();
    replyToAnnotation(s.annotationsDoc, id, { author: "Bob", body: "and?" });
    await s.settle();
    expect(s.card(id)?.querySelector(".awaiting-mark")).not.toBeNull();
  });
});

describe("the count and ‹ ›", () => {
  test("how many; the first, the next, the previous in the text's order, around; F8", async () => {
    const s = setUp();
    // Created out of the text's order.
    const late = s.comment(16, "Bob");
    const early = s.comment(0, "Bob");
    s.comment(8, "Alice");
    await s.settle();
    const count = s.header.querySelector<HTMLButtonElement>(".awaiting-count");
    expect(count?.textContent).toContain("2");
    count?.click();
    expect(s.active.id).toBe(early);
    s.header.querySelector<HTMLButtonElement>(".awaiting-next")?.click();
    expect(s.active.id).toBe(late);
    s.header.querySelector<HTMLButtonElement>(".awaiting-next")?.click();
    expect(s.active.id).toBe(early);
    s.header.querySelector<HTMLButtonElement>(".awaiting-previous")?.click();
    expect(s.active.id).toBe(late);
    s.keys.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F8", bubbles: true }),
    );
    expect(s.active.id).toBe(early);
    s.keys.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F8",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(s.active.id).toBe(late);
  });

  test("none: said, without arrows", async () => {
    const s = setUp();
    s.comment(0, "Alice");
    await s.settle();
    expect(s.header.querySelector(".awaiting-none")).not.toBeNull();
    expect(s.header.querySelector(".awaiting-next")).toBeNull();
  });
});

describe("the review's walk", () => {
  test("a reviewer walks what awaits it; replying goes on to the next", async () => {
    const s = setUp("suggest");
    const a = s.comment(0, "Bob");
    s.comment(8, "Alice");
    const c = s.comment(16, "Bob");
    await s.settle();
    s.panel.setLayout("sheet");
    s.panel.setReview(true);
    expect(s.panelParent.querySelector(".sheet-count")?.textContent).toContain(
      "2",
    );
    s.active.set(a, "review");
    flushSync();
    // Through the card, as by hand.
    s.card(a)?.querySelector<HTMLButtonElement>(".reply-open")?.click();
    flushSync();
    const field = s.card(a)?.querySelector<HTMLTextAreaElement>(".reply-text");
    if (!field) throw new Error("no reply field");
    field.value = "done";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    s.card(a)?.querySelector<HTMLButtonElement>(".reply-send")?.click();
    await s.settle();
    expect(s.active.id).toBe(c);
  });

  test("« Nothing to add » in the walk goes on too; the last one says nothing is left", async () => {
    const s = setUp("suggest");
    const a = s.comment(0, "Bob");
    await s.settle();
    s.panel.setLayout("sheet");
    s.panel.setReview(true);
    s.active.set(a, "review");
    flushSync();
    s.card(a)?.querySelector<HTMLButtonElement>(".set-aside")?.click();
    await s.settle();
    expect(s.panelParent.querySelector(".review-done")).not.toBeNull();
  });

  test("an editor chooses: to decide, or to answer", async () => {
    const s = setUp("edit");
    s.comment(0, "Bob");
    s.comment(8, "Alice");
    await s.settle();
    s.panel.setLayout("sheet");
    s.panel.setReview(true);
    flushSync();
    const count = () =>
      s.panelParent.querySelector(".sheet-count")?.textContent ?? "";
    // Both comments to resolve.
    expect(count()).toContain("2");
    const [, toAnswer] = Array.from(
      s.panelParent.querySelectorAll<HTMLButtonElement>(".walk-choice button"),
    );
    toAnswer?.click();
    flushSync();
    expect(count()).toContain("1");
  });
});

describe("a reader", () => {
  test("no mark, no count", async () => {
    const s = setUp("read");
    const id = s.comment(0, "Bob");
    await s.settle();
    expect(s.card(id)?.querySelector(".awaiting-mark")).toBeNull();
    expect(s.card(id)?.querySelector(".set-aside")).toBeNull();
    expect(s.header.childElementCount).toBe(0);
  });
});
