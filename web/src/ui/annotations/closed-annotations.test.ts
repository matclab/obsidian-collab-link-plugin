// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { beforeEach, describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  applyDecisionEffects,
  createAnnotation,
  updateStatus,
} from "../../../lib/src/annotations/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { locatedAt } from "../../editor/located-passage.js";
import { withoutLayout } from "../../editor/test-support/no-layout.js";
import { registerPeers } from "../../history/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import { createAnnotationsPanel } from "./annotations-panel.js";

/** The closed annotations reviewed (ADR-0052 §1 to §4). */

// Its text shown, the passage is scrolled into view (phase 27).
const destroyAfter = withoutLayout();

function setUp(role: "read" | "suggest" | "edit" = "edit") {
  const contentDoc = new LoroDoc();
  contentDoc.setPeerId(1n);
  contentDoc.setRecordTimestamp(true);
  contentDoc.getText("content").insert(0, "hello world, and more");
  contentDoc.setNextCommitTimestamp(1_000);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  destroyAfter(editor.view);
  const parent = document.createElement("div");
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const published: Uint8Array[] = [];
  const decisions = new LocalDecisions(log, (record) => published.push(record));
  let seq = 0;
  const confirm = () =>
    log.add(published.splice(0).map((record) => ({ seq: ++seq, record })));
  const comment = (start: number, end: number, body: string) =>
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end,
      author: "alice",
      body,
    });
  const panel = createAnnotationsPanel(
    parent,
    editor,
    index,
    () => "bob",
    decisions,
    () => {},
    role,
  );
  const cards = () =>
    Array.from(parent.querySelectorAll<HTMLElement>(".annotation-item"));
  const card = (id: string) =>
    cards().find((item) => item.dataset.id === id) as HTMLElement;
  const filter = (name: "open" | "closed" | "all") =>
    parent.querySelector<HTMLButtonElement>(
      `.annotations-filter [data-filter="${name}"]`,
    );
  return {
    contentDoc,
    annotationsDoc,
    log,
    decisions,
    confirm,
    comment,
    panel,
    parent,
    cards,
    card,
    filter,
    editor,
  };
}

const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(() => resetCounters());

describe("the filter: open, closed, all (ADR-0052 §1)", () => {
  test("open ones by default; closed ones in their own view; all, open first; each with its count", async () => {
    const { annotationsDoc, comment, cards, filter, parent } = setUp();
    const first = comment(0, 5, "first");
    const second = comment(6, 11, "second");
    const third = comment(13, 16, "third");
    updateStatus(annotationsDoc, first, "resolved");
    await notified();

    expect(parent.querySelector(".closed-annotations")).toBeNull();
    expect(filter("open")?.textContent).toContain("2");
    expect(filter("closed")?.textContent).toContain("1");
    expect(filter("all")?.textContent).toContain("3");
    expect(filter("open")?.getAttribute("aria-pressed")).toBe("true");
    // Created in the same millisecond: in either order.
    const ids = () => cards().map((card) => card.dataset.id);
    expect(ids().sort()).toEqual([second, third].sort());

    filter("closed")?.click();
    expect(filter("closed")?.getAttribute("aria-pressed")).toBe("true");
    expect(cards().map((card) => card.dataset.id)).toEqual([first]);

    filter("all")?.click();
    expect(ids().slice(0, 2).sort()).toEqual([second, third].sort());
    expect(ids()[2]).toBe(first);
  });

  test("a reader has it too", async () => {
    const { annotationsDoc, comment, filter, cards } = setUp("read");
    const id = comment(0, 5, "first");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();

    expect(filter("closed")).not.toBeNull();
    filter("closed")?.click();
    expect(cards().map((card) => card.dataset.id)).toEqual([id]);
  });
});

describe("a closed card (ADR-0052 §2)", () => {
  test("says who decided it", async () => {
    const {
      contentDoc,
      annotationsDoc,
      log,
      comment,
      panel,
      confirm,
      card,
      filter,
    } = setUp();
    const id = comment(0, 5, "first");
    await notified();
    panel.resolve(id);
    confirm();
    applyDecisionEffects(contentDoc, annotationsDoc, log);
    await notified();

    filter("closed")?.click();
    const status = card(id).querySelector(".card-status")?.textContent;
    expect(status).toContain("resolved");
    expect(status).toContain("bob");
  });

  test("closed without a decision received: its status only", async () => {
    const { annotationsDoc, comment, card, filter } = setUp();
    const id = comment(0, 5, "first");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();

    filter("closed")?.click();
    const status = card(id).querySelector(".card-status")?.textContent;
    expect(status).toContain("resolved");
    expect(status).not.toContain("by");
  });
});

describe("« Text deleted » (ADR-0052 §3)", () => {
  test("on an open annotation whose text is all gone, not on an addition", async () => {
    const { contentDoc, comment, card } = setUp();
    const id = comment(6, 11, "about world");
    contentDoc.getText("content").delete(5, 7);
    contentDoc.commit();
    await notified();

    expect(card(id).querySelector(".card-deleted")?.textContent).toBe(
      "Text deleted",
    );
    expect(card(id).querySelector(".card-quote")).toBeNull();
  });
});

describe("« See the annotated text » (ADR-0052 §4)", () => {
  test("a closed card: the text it covers now, on a click only; folded by a redraw", async () => {
    const { annotationsDoc, comment, card, filter } = setUp();
    const id = comment(6, 11, "about world");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    filter("closed")?.click();
    filter("all")?.click();
    expect(counter("annotations.textThen")).toBe(0);
    expect(counter("cursor.resolve")).toBe(0);

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(card(id).querySelector(".card-then")?.textContent).toContain(
      "world",
    );
    expect(
      card(id).querySelector(".see-text")?.getAttribute("aria-expanded"),
    ).toBe("true");

    // A redraw of the card folds the text.
    updateStatus(annotationsDoc, id, "accepted");
    await notified();
    expect(card(id).querySelector(".card-then")).toBeNull();
  });

  test("its text deleted: the last text it covered, who deleted it and when", async () => {
    const { contentDoc, annotationsDoc, comment, card } = setUp();
    registerPeers(annotationsDoc, [contentDoc.peerIdStr], "carol");
    const id = comment(6, 11, "about world");
    contentDoc.getText("content").delete(5, 7);
    // Long after: a change of its own, not merged with the first.
    contentDoc.setNextCommitTimestamp(100_000);
    contentDoc.commit();
    await notified();

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    const then = card(id).querySelector(".card-then")?.textContent;
    expect(then).toContain("world");
    expect(then).toContain("carol");
    expect(counter("annotations.textThen")).toBeGreaterThan(0);
  });

  test("unavailable when the history doesn't say", async () => {
    const { annotationsDoc, card, filter } = setUp();
    // Anchored on a text this page never received.
    const other = new LoroDoc();
    other.setPeerId(9n);
    other.getText("content").insert(0, "elsewhere");
    other.commit();
    const id = createAnnotation(other, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 4,
      author: "alice",
      body: "lost",
    });
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    filter("closed")?.click();

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(card(id).querySelector(".card-then")?.textContent?.trim()).toBe(
      "Earlier text unavailable",
    );
  });
});

describe("in the sheet (ADR-0052 §1)", () => {
  test("the filter with every card listed; the toggle then goes back to one at a time", async () => {
    const { annotationsDoc, comment, panel, parent, filter, cards } = setUp();
    comment(0, 5, "first");
    const closed = comment(6, 11, "second");
    updateStatus(annotationsDoc, closed, "resolved");
    await notified();
    panel.setLayout("sheet");
    panel.openSheet();
    expect(filter("closed")).toBeNull();

    const toggle = () => parent.querySelector<HTMLButtonElement>(".sheet-all");
    expect(toggle()?.textContent).toBe("All (1)");
    toggle()?.click();
    expect(toggle()?.textContent).toBe("One at a time");
    filter("closed")?.click();
    expect(cards().map((card) => card.dataset.id)).toEqual([closed]);
  });
});

/** In the margin, the card follows its text (phase 27). */
describe("where a closed card stands (phase 27)", () => {
  const listOf = (card: HTMLElement) =>
    card.parentElement?.classList.contains("open-list") ? "open" : "closed";

  test("its text shown: in the margin, active, its passage marked; hidden: back in its list, unmarked", async () => {
    const { annotationsDoc, comment, card, filter, panel, editor } = setUp();
    const id = comment(6, 11, "about world");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    panel.setLayout("margin");
    filter("closed")?.click();
    expect(listOf(card(id))).toBe("closed");

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(listOf(card(id))).toBe("open");
    expect(panel.active.id).toBe(id);
    expect(card(id).querySelector(".card-then")?.textContent).toContain(
      "world",
    );
    expect(locatedAt(editor.view.state)).toEqual({ id, from: 6, to: 11 });

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(listOf(card(id))).toBe("closed");
    expect(card(id).querySelector(".card-then")).toBeNull();
    expect(locatedAt(editor.view.state)).toBeUndefined();
  });

  test("its text deleted: the point where it was; the mark follows the typing, which resolves nothing", async () => {
    const { contentDoc, annotationsDoc, comment, card, filter, panel, editor } =
      setUp();
    const id = comment(6, 11, "about world");
    contentDoc.getText("content").delete(5, 7);
    contentDoc.setNextCommitTimestamp(100_000);
    contentDoc.commit();
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    panel.setLayout("margin");
    filter("closed")?.click();

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(locatedAt(editor.view.state)).toEqual({ id, from: 5, to: 5 });

    resetCounters();
    editor.view.dispatch({ changes: { from: 0, insert: ">> " } });
    expect(locatedAt(editor.view.state)).toEqual({ id, from: 8, to: 8 });
    expect(counter("cursor.resolve")).toBe(0);
  });

  test("another card chosen: unmarked, and the closed one back in its list", async () => {
    const { annotationsDoc, comment, card, filter, panel, editor } = setUp();
    const open = comment(0, 5, "first");
    const id = comment(6, 11, "about world");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    panel.setLayout("margin");
    filter("all")?.click();

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    panel.active.set(open, "mark");
    expect(locatedAt(editor.view.state)).toBeUndefined();
    expect(listOf(card(id))).toBe("closed");
  });

  test("in a list (no margin): marked, the card stays in its list", async () => {
    const { annotationsDoc, comment, card, filter, editor } = setUp();
    const id = comment(6, 11, "about world");
    updateStatus(annotationsDoc, id, "resolved");
    await notified();
    filter("closed")?.click();

    card(id).querySelector<HTMLButtonElement>(".see-text")?.click();
    expect(listOf(card(id))).toBe("closed");
    expect(locatedAt(editor.view.state)).toEqual({ id, from: 6, to: 11 });
  });
});
