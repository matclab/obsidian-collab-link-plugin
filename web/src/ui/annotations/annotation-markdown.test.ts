// @vitest-environment jsdom
//
// An annotation's text rendered as Markdown on its card (ADR-0047, phase
// 21b): the comment's body, a suggestion's note, each reply; and what it
// costs (MA4).
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  applyDecisionEffects,
  createAnnotation,
  replyToAnnotation,
} from "../../../lib/src/annotations/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { counter, resetCounters } from "../../perf/index.js";
import { createAnnotationsPanel } from "./annotations-panel.js";

/** `count` comments on a text of as many words, each with its body, and
 * one addition with its note. */
function setUp(count = 1, body = (i: number) => `**bold** ${i}`) {
  const contentDoc = new LoroDoc();
  contentDoc
    .getText("content")
    .insert(0, Array.from({ length: count + 1 }, (_, i) => `w${i}`).join(" "));
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const ids = Array.from({ length: count }, (_, i) => {
    const start = contentDoc.getText("content").toString().indexOf(`w${i}`);
    return createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end: start + 2,
      author: "bob",
      body: body(i),
    });
  });
  const end = contentDoc.getText("content").length;
  const suggestion = createAnnotation(contentDoc, annotationsDoc, {
    type: "addition",
    start: end,
    end,
    author: "bob",
    replacement: "!",
    note: "a `note`",
  });
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const parent = document.createElement("div");
  document.body.append(parent);
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const published: Uint8Array[] = [];
  const decisions = new LocalDecisions(log, (record) => published.push(record));
  // What was published, confirmed as the decisions channel would.
  const confirm = () => {
    log.add(published.splice(0).map((record, i) => ({ seq: i + 1, record })));
    applyDecisionEffects(contentDoc, annotationsDoc, log);
  };
  resetCounters();
  const panel = createAnnotationsPanel(
    parent,
    editor,
    index,
    () => "alice",
    decisions,
  );
  const card = (id: string) =>
    parent.querySelector<HTMLElement>(`.annotation-item[data-id="${id}"]`);
  // Every card shown, open and closed (ADR-0052 §1).
  const showAll = () =>
    parent
      .querySelector<HTMLButtonElement>(
        '.annotations-filter [data-filter="all"]',
      )
      ?.click();
  return {
    showAll,
    contentDoc,
    annotationsDoc,
    editor,
    ids,
    suggestion,
    parent,
    panel,
    card,
    confirm,
  };
}

const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("an annotation's text on its card", () => {
  test("a body, a note and a reply are rendered", async () => {
    const { annotationsDoc, ids, suggestion, card, panel } = setUp();
    const [id = ""] = ids;
    replyToAnnotation(annotationsDoc, id, {
      author: "carol",
      body: "- one\n- two",
    });
    await notified();

    expect(card(id)?.querySelector(".card-body strong")?.textContent).toBe(
      "bold",
    );
    expect(
      card(suggestion)?.querySelector(".card-note code")?.textContent,
    ).toBe("note");
    expect(
      Array.from(
        card(id)?.querySelectorAll(".reply-body li") ?? [],
        (item) => item.textContent,
      ),
    ).toEqual(["one", "two"]);
    panel.destroy();
  });

  test("a link leaves the document in a new tab; one inside it is text; no id", () => {
    const { ids, card, parent, panel } = setUp(
      1,
      () => "[out](https://e.org/x) [in](#title)",
    );
    const [id = ""] = ids;
    const links = Array.from(card(id)?.querySelectorAll(".card-body a") ?? []);
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link?.getAttribute("href")).toBe("https://e.org/x");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(card(id)?.querySelector(".card-body")?.textContent).toBe("out in");
    expect(parent.querySelector(".card-body [id], .card-note [id]")).toBeNull();
    panel.destroy();
  });

  test("a click on a link selects its card, and changes no fragment", () => {
    const { ids, card, panel } = setUp(2, () => "[out](https://e.org/x)");
    const [first = "", second = ""] = ids;
    const hash = location.hash;
    card(first)?.querySelector("a")?.click();
    expect(card(first)?.classList.contains("active")).toBe(true);
    expect(card(second)?.classList.contains("active")).toBe(false);
    expect(location.hash).toBe(hash);
    panel.destroy();
  });

  test("a reply keeps its line breaks", async () => {
    const { annotationsDoc, ids, card, panel } = setUp();
    const [id = ""] = ids;
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "a\nb" });
    await notified();
    expect(card(id)?.querySelector(".reply-body")?.innerHTML).toBe(
      "<p>a<br>\nb</p>",
    );
    panel.destroy();
  });
});

// MA4 (ADR-0047 §9): a text is rendered when it appears, never again.
describe("rendering an annotation's text costs (MA4)", () => {
  test("opening renders each text shown once", () => {
    const { panel } = setUp(5);
    // Five bodies, one note.
    expect(counter("annotation.text.render")).toBe(6);
    panel.destroy();
  });

  test("grows with the annotations, once each", () => {
    const small = setUp(4);
    const few = counter("annotation.text.render");
    small.panel.destroy();
    const large = setUp(16);
    const many = counter("annotation.text.render");
    large.panel.destroy();
    expect(few).toBe(5);
    expect(many).toBe(17);
  });

  test("a keystroke renders no text", async () => {
    const { editor, panel } = setUp(5);
    resetCounters();
    editor.view.dispatch({
      changes: { from: 0, insert: "k" },
      userEvent: "input.type",
    });
    await notified();
    expect(counter("annotation.text.render")).toBe(0);
    panel.destroy();
  });

  test("resolving an annotation renders no text, though its card moves", async () => {
    const { ids, card, panel, confirm, showAll } = setUp(5);
    const [id = ""] = ids;
    showAll();
    resetCounters();
    panel.resolve(id);
    confirm();
    await notified();
    expect(card(id)?.classList.contains("closed")).toBe(true);
    expect(counter("panel.render")).toBeGreaterThan(0);
    expect(counter("annotation.text.render")).toBe(0);
    panel.destroy();
  });

  test("a reply received renders it, and nothing else", async () => {
    const { annotationsDoc, ids, panel } = setUp(5);
    const [id = ""] = ids;
    resetCounters();
    replyToAnnotation(annotationsDoc, id, { author: "carol", body: "why?" });
    await notified();
    expect(counter("panel.render")).toBe(1);
    expect(counter("annotation.text.render")).toBe(1);
    panel.destroy();
  });
});
