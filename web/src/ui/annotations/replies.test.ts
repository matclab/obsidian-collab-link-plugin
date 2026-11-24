// @vitest-environment jsdom
//
// Replies on a card (ADR-0035, phase 13b, decision 7): the thread under
// the annotation's text, and a field to reply, for a reviewer or an
// editor, on an open annotation.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  MAX_TEXT_BYTES,
  createAnnotation,
  replyToAnnotation,
  resolveAnnotation,
  updateStatus,
} from "../../../lib/src/annotations/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { formatShortDate, t } from "../../i18n/index.js";
import { counter, resetCounters } from "../../perf/index.js";
import {
  type PanelAction,
  createAnnotationsPanel,
} from "./annotations-panel.js";

function setUp(role: "read" | "suggest" | "edit" = "suggest") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, "hello world");
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const id = createAnnotation(contentDoc, annotationsDoc, {
    type: "deletion",
    start: 0,
    end: 5,
    author: "bob",
    createdAt: 1_500_000_000_000,
  });
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const parent = document.createElement("div");
  document.body.append(parent);
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const decisions = new LocalDecisions(log, () => {});
  const actions: PanelAction[] = [];
  const panel = createAnnotationsPanel(
    parent,
    editor,
    index,
    () => "alice",
    decisions,
    (action) => actions.push(action),
    role,
  );
  const card = () =>
    parent.querySelector<HTMLElement>(`.annotation-item[data-id="${id}"]`);
  const field = () => card()?.querySelector<HTMLTextAreaElement>(".reply-text");
  const openButton = () =>
    card()?.querySelector<HTMLButtonElement>(".reply-open");
  const thread = () =>
    Array.from(card()?.querySelectorAll(".card-reply") ?? [], (item) => ({
      author: item.querySelector(".reply-author")?.textContent,
      when: item.querySelector(".reply-when")?.textContent,
      body: item.querySelector(".reply-body")?.textContent,
    }));
  const type = (text: string) => {
    const input = field();
    if (!input) throw new Error("no reply field");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (init: KeyboardEventInit) =>
    field()?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ...init }),
    );
  const stored = () =>
    resolveAnnotation(contentDoc, annotationsDoc, id)?.replies.map(
      (r) => r.body,
    );
  return {
    contentDoc,
    annotationsDoc,
    id,
    parent,
    panel,
    actions,
    card,
    field,
    openButton,
    thread,
    type,
    key,
    stored,
  };
}

const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("the thread on a card", () => {
  test("the annotation's date, in its head, as a reply's", () => {
    const { card } = setUp();
    expect(
      card()?.querySelector(".card-head-line .card-when")?.textContent,
    ).toBe(formatShortDate(1_500_000_000_000));
  });

  test("shows each reply, author, date and text, in the list's order", async () => {
    const { annotationsDoc, id, thread, panel } = setUp();
    replyToAnnotation(annotationsDoc, id, {
      author: "carol",
      body: "why?",
      createdAt: 2_000_000_000_000,
    });
    replyToAnnotation(annotationsDoc, id, {
      author: "bob",
      body: "a typo\nsee line 2",
      createdAt: 1_000_000_000_000,
    });
    await notified();

    expect(thread()).toEqual([
      {
        author: "carol",
        when: formatShortDate(2_000_000_000_000),
        body: "why?",
      },
      {
        author: "bob",
        when: formatShortDate(1_000_000_000_000),
        body: "a typo\nsee line 2",
      },
    ]);
    panel.destroy();
  });

  test("a reply's text is text, never markup (D-36)", async () => {
    const { annotationsDoc, id, card, panel } = setUp();
    replyToAnnotation(annotationsDoc, id, {
      author: "<b>x</b>",
      body: "<img src=x onerror=alert(1)>",
    });
    await notified();

    expect(card()?.querySelector("img, b")).toBeNull();
    expect(card()?.querySelector(".reply-body")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    panel.destroy();
  });

  test("a closed annotation keeps its thread, and offers no reply", async () => {
    const { annotationsDoc, id, card, openButton, thread, panel, parent } =
      setUp();
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "ok" });
    updateStatus(annotationsDoc, id, "rejected");
    await notified();
    parent
      .querySelector<HTMLButtonElement>(
        '.annotations-filter [data-filter="closed"]',
      )
      ?.click();

    expect(card()?.classList.contains("closed")).toBe(true);
    expect(thread().map((r) => r.body)).toEqual(["ok"]);
    expect(openButton()).toBeFalsy();
    panel.destroy();
  });

  test("says how many replies, for the folded card", async () => {
    const { annotationsDoc, id, card, panel } = setUp();
    expect(card()?.querySelector(".reply-count")).toBeNull();
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "a" });
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "b" });
    await notified();

    expect(card()?.querySelector(".reply-count")?.textContent).toBe(
      t().replyCount(2),
    );
    panel.destroy();
  });
});

describe("replying", () => {
  test("a reviewer and an editor may reply; a reader may not", () => {
    for (const role of ["suggest", "edit"] as const) {
      const { openButton, panel } = setUp(role);
      expect(openButton()?.textContent).toBe(t().reply);
      panel.destroy();
    }
    const { openButton, panel } = setUp("read");
    expect(openButton()).toBeFalsy();
    panel.destroy();
  });

  test("Reply opens a field; Ctrl+Enter sends, signed, and closes it", () => {
    const { openButton, field, type, key, stored, thread, actions, id, panel } =
      setUp();
    openButton()?.click();
    expect(field()).toBeTruthy();
    expect(document.activeElement).toBe(field());

    type("why?");
    key({ key: "Enter", ctrlKey: true });

    expect(stored()).toEqual(["why?"]);
    expect(thread().map((r) => r.author)).toEqual(["alice"]);
    expect(field()).toBeFalsy();
    expect(actions).toContainEqual({ kind: "reply", id, body: "why?" });
    panel.destroy();
  });

  test("Enter goes to the line, as in the toolbar; Cmd+Enter sends too", () => {
    const { openButton, field, type, key, stored, panel } = setUp();
    openButton()?.click();
    type("line one");
    key({ key: "Enter" });
    expect(field()).toBeTruthy();
    expect(stored()).toEqual([]);

    key({ key: "Enter", metaKey: true });
    expect(stored()).toEqual(["line one"]);
    panel.destroy();
  });

  test("the Send button sends; Escape and Cancel close without sending", () => {
    const { openButton, field, type, key, card, stored, panel } = setUp();
    openButton()?.click();
    type("draft");
    key({ key: "Escape" });
    expect(field()).toBeFalsy();
    expect(stored()).toEqual([]);

    openButton()?.click();
    type("draft");
    card()?.querySelector<HTMLButtonElement>(".reply-cancel")?.click();
    expect(field()).toBeFalsy();

    openButton()?.click();
    type("sent");
    card()?.querySelector<HTMLButtonElement>(".reply-send")?.click();
    expect(stored()).toEqual(["sent"]);
    panel.destroy();
  });

  test("an empty or blank reply is not sent, and says why", () => {
    const { openButton, field, type, key, card, stored, panel } = setUp();
    openButton()?.click();
    type("  \n ");
    key({ key: "Enter", ctrlKey: true });

    expect(stored()).toEqual([]);
    expect(field()).toBeTruthy();
    expect(card()?.querySelector(".reply-error")?.textContent).toBe(
      t().typeReplyFirst,
    );
    panel.destroy();
  });

  test("a reply too large is refused, and says why", () => {
    const { openButton, type, key, card, stored, panel } = setUp();
    openButton()?.click();
    type("x".repeat(MAX_TEXT_BYTES + 1));
    key({ key: "Enter", ctrlKey: true });

    expect(stored()).toEqual([]);
    expect(card()?.querySelector(".reply-error")?.textContent).toBe(
      t().textTooLarge,
    );
    panel.destroy();
  });

  // The margin places the cards on each rendering (margin.ts): a card
  // that grows or shrinks with its field must be placed again.
  test("opening, closing, or a message in the field tells the margin", () => {
    const { openButton, type, key, panel } = setUp();
    let rendered = 0;
    panel.onRendered(() => rendered++);
    openButton()?.click();
    expect(rendered).toBe(1);
    type(" ");
    key({ key: "Enter", ctrlKey: true }); // refused: a message
    expect(rendered).toBe(2);
    key({ key: "Escape" });
    expect(rendered).toBe(3);
    panel.destroy();
  });

  test("a click in the field doesn't select the card again", () => {
    const { openButton, field, panel } = setUp();
    let selected = 0;
    const unfollow = panel.active.subscribe(() => selected++);
    openButton()?.click();
    selected = 0;
    field()?.click();
    expect(selected).toBe(0);
    unfollow();
    panel.destroy();
  });

  test("what is typed stays while another change redraws the card", async () => {
    const { annotationsDoc, id, openButton, field, type, panel } = setUp();
    openButton()?.click();
    type("half typed");
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "first" });
    await notified();

    expect(field()?.value).toBe("half typed");
    panel.destroy();
  });
});

// AGENTS.md §6, phase 13 decision 8: a keystroke in the field is the
// field's business.
describe("typing a reply (budget)", () => {
  test("resolves nothing, renders nothing, writes nothing", async () => {
    const { annotationsDoc, openButton, type, panel } = setUp();
    openButton()?.click();
    const version = annotationsDoc.version().toJSON();
    resetCounters();

    for (const text of ["w", "wh", "why", "why?"]) type(text);
    await notified();

    expect(counter("annotations.resolveAll")).toBe(0);
    expect(counter("panel.render")).toBe(0);
    expect(counter("cursor.resolve")).toBe(0);
    expect(annotationsDoc.version().toJSON()).toEqual(version);
    panel.destroy();
  });
});

describe("a comment's body too large", () => {
  test("is refused by the panel with a message, not an exception", () => {
    const { panel } = setUp();
    expect(panel.create("comment", "x".repeat(MAX_TEXT_BYTES + 1), "")).toBe(
      t().textTooLarge,
    );
    panel.destroy();
  });
});
