// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  DecisionLog,
  LocalDecisions,
  applyDecisionEffects,
  createAnnotation,
  createDetachedChange,
  encodeProposal,
  listAnnotations,
  tryCreateAnnotation,
} from "../../../lib/src/annotations/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { createAnnotationsPanel } from "./annotations-panel.js";

function setUp(text = "hello world") {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  const editorParent = document.createElement("div");
  const editor = createDocumentEditor(editorParent, contentDoc);
  const panelParent = document.createElement("div");
  // A stand-in for the decisions channel: what was published, in order,
  // and confirmed only when a test says so.
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const published: Uint8Array[] = [];
  const decisions = new LocalDecisions(log, (record) => published.push(record));
  let seq = 0;
  const confirm = (...records: Uint8Array[]) =>
    log.add(records.map((record) => ({ seq: ++seq, record })));
  return {
    contentDoc,
    annotationsDoc,
    index,
    editor,
    panelParent,
    decisions,
    log,
    published,
    confirm,
  };
}

/** Changes made elsewhere reach the panel through the index, which
 * notifies in a microtask. */
const notified = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function selectRange(
  editor: ReturnType<typeof createDocumentEditor>,
  from: number,
  to: number,
) {
  editor.view.dispatch({ selection: { anchor: from, head: to } });
}

describe("createAnnotationsPanel", () => {
  test("creating a comment annotation from the editor's selection makes it appear in the list", () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    selectRange(editor, 6, 11); // "world"
    expect(panel.create("comment", "nice section", "")).toBeUndefined();

    const items = panelParent.querySelectorAll(".annotation-item");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("comment");
    expect(items[0]?.textContent).toContain("alice");
    expect(items[0]?.textContent).toContain("world");
    expect(items[0]?.textContent).toContain("nice section");

    panel.destroy();
  });

  // Phase 34j, NI1: what invites to be notified.
  test("an annotation written is told, once written", () => {
    const { index, editor, panelParent, decisions } = setUp();
    const written: string[] = [];
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
      undefined,
      "edit",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (w) => written.push(w.kind),
    );
    selectRange(editor, 6, 11);
    expect(panel.create("addition", "", "")).toBeDefined();
    expect(written).toEqual([]);
    panel.create("comment", "nice", "");
    expect(written).toEqual(["annotation"]);
    panel.destroy();
  });

  // Phase 7 decision 9: the pseudonym read at each creation; earlier
  // annotations keep the name they were made under.
  test("a renamed author signs the next annotation only", () => {
    const { index, editor, panelParent, decisions } = setUp();
    let name = "alice";
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => name,
      decisions,
    );
    const comment = (from: number, to: number, body: string) => {
      selectRange(editor, from, to);
      panel.create("comment", body, "");
    };

    comment(0, 5, "first");
    name = "Alice B.";
    comment(6, 11, "second");

    const authors = [...index.current().byId.values()]
      .map((annotation) => `${annotation.body}:${annotation.author}`)
      .sort();
    expect(authors).toEqual(["first:alice", "second:Alice B."]);
    panel.destroy();
  });

  test("creating an annotation that would cross an existing one is refused and adds nothing", () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    function createComment(from: number, to: number, body: string) {
      selectRange(editor, from, to);
      return panel.create("comment", body, "");
    }

    expect(createComment(0, 7, "first")).toBeUndefined(); // "hello w"
    // "o world" — crosses the first
    expect(createComment(5, 11, "second")).toContain("Crosses annotation");

    expect(panelParent.querySelectorAll(".annotation-item")).toHaveLength(1);

    panel.destroy();
  });

  test("a crossing pair created by two concurrent peers appears in the conflicts panel without any local action", async () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    const contentPeer = new LoroDoc();
    contentPeer.setPeerId(2n);
    contentPeer.import(contentDoc.export({ mode: "update" }));
    const annotationsPeer = new LoroDoc();
    annotationsPeer.setPeerId(2n);

    // Each individually valid from its own author's point of view.
    tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "alice",
      body: "a",
    });
    tryCreateAnnotation(contentPeer, annotationsPeer, {
      type: "comment",
      start: 5,
      end: 11,
      author: "bob",
      body: "b",
    });

    annotationsDoc.import(annotationsPeer.export({ mode: "update" }));
    await notified();

    expect(panelParent.querySelectorAll(".card-conflict")).toHaveLength(2);

    panel.destroy();
  });

  function createDeletionOfHello(
    panel: ReturnType<typeof createAnnotationsPanel>,
    editor: ReturnType<typeof createDocumentEditor>,
  ) {
    selectRange(editor, 0, 6); // "hello "
    panel.create("deletion", "", "");
  }

  const button = (parent: Element, action: string) =>
    parent.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  const itemText = (parent: Element) =>
    parent.querySelector(".annotation-item")?.textContent ?? "";

  test("accepting publishes a proposal and shows it pending, without touching the text", () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
      published,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );
    createDeletionOfHello(panel, editor);

    button(panelParent, "accept")?.click();

    expect(published).toHaveLength(1);
    expect(contentDoc.getText("content").toString()).toBe("hello world");
    expect(itemText(panelParent)).toContain("pending");
    expect(button(panelParent, "accept")).toBeNull();
    expect(button(panelParent, "reject")).toBeNull();

    panel.destroy();
  });

  // O-18: a reviewer's change too large for a proposal (written by another
  // client: this one refuses to create it) is never sent, and says so.
  test("accepting a change too large for a proposal publishes nothing and says why", async () => {
    const { contentDoc, annotationsDoc, index, editor, panelParent, log } =
      setUp();
    const published: Uint8Array[] = [];
    const decisions = new LocalDecisions(
      log,
      (record) => published.push(record),
      undefined,
      1000,
    );
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );
    createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 5,
      end: 5,
      author: "bob",
      change: new Uint8Array(800),
    });
    await notified();

    button(panelParent, "accept")?.click();

    expect(published).toEqual([]);
    expect(panelParent.querySelector(".panel-error")?.textContent).toContain(
      "too large",
    );
    panel.destroy();
  });

  test("once confirmed and applied, the text changes and the status reads accepted", async () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
      log,
      published,
      confirm,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );
    createDeletionOfHello(panel, editor);
    button(panelParent, "accept")?.click();

    confirm(...published);
    applyDecisionEffects(contentDoc, annotationsDoc, log);
    await notified();

    expect(contentDoc.getText("content").toString()).toBe("world");
    // Closed: under « Closed » (ADR-0052 §1).
    panelParent
      .querySelector<HTMLButtonElement>(
        '.annotations-filter [data-filter="closed"]',
      )
      ?.click();
    expect(itemText(panelParent)).toContain("accepted");
    expect(itemText(panelParent)).not.toContain("pending");
    // Closed: listed without its excerpt, its range not resolved (phase 9,
    // E4: it may cost a walk of the history once its text is rewritten).
    expect(
      panelParent.querySelector(".annotation-item .card-quote"),
    ).toBeNull();

    panel.destroy();
  });

  test("a decision that turns out to lose says so explicitly", async () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
      published,
      confirm,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );
    createDeletionOfHello(panel, editor);
    const id = panelParent.querySelector<HTMLElement>(".annotation-item")
      ?.dataset.id as string;
    button(panelParent, "accept")?.click();

    confirm(
      encodeProposal({
        proposalId: "bob-1",
        annotationId: id,
        decision: "reject",
        author: "bob",
      }),
      ...published,
    );
    await notified();

    const lost = panelParent.querySelector(".decision-lost");
    expect(lost?.textContent).toContain("bob");
    expect(lost?.textContent).toContain("rejected");

    panel.destroy();
  });

  test("an addition proposes the text typed in the field at the cursor, without writing it to content (ADR-0018)", () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    selectRange(editor, 5, 5); // caret right after "hello"
    expect(panel.create("addition", " dear", "warmer")).toBeUndefined();

    expect(contentDoc.getText("content").toString()).toBe("hello world");
    expect(editor.view.state.doc.toString()).toBe("hello world");
    const item = panelParent.querySelector(".annotation-item");
    expect(item?.querySelector("ins")?.textContent).toBe(" dear");
    expect(item?.querySelector(".card-note")?.textContent).toBe("warmer");

    panel.destroy();
  });

  test("a suggestion whose change is invalid says so, and still offers the decision", () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
    } = setUp();
    const id = createAnnotation(contentDoc, annotationsDoc, {
      type: "addition",
      start: 5,
      end: 5,
      author: "mallory",
      change: new Uint8Array([1, 2, 3]),
    });
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    const item = panelParent.querySelector(`.annotation-item[data-id="${id}"]`);
    expect(item?.textContent).toContain("(invalid change)");
    expect(item?.querySelector('button[data-action="reject"]')).not.toBeNull();
    panel.destroy();
  });

  test("resolving one of two conflicting comments removes the pair from the conflicts panel, once confirmed", async () => {
    const {
      contentDoc,
      annotationsDoc,
      index,
      editor,
      panelParent,
      decisions,
      log,
      published,
      confirm,
    } = setUp();
    const panel = createAnnotationsPanel(
      panelParent,
      editor,
      index,
      () => "alice",
      decisions,
    );

    const idA = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start: 0,
      end: 7,
      author: "alice",
      body: "a",
    });
    const contentPeer = new LoroDoc();
    contentPeer.setPeerId(2n);
    contentPeer.import(contentDoc.export({ mode: "update" }));
    const annotationsPeer = new LoroDoc();
    annotationsPeer.setPeerId(2n);
    tryCreateAnnotation(contentPeer, annotationsPeer, {
      type: "comment",
      start: 5,
      end: 11,
      author: "bob",
      body: "b",
    });
    annotationsDoc.import(annotationsPeer.export({ mode: "update" }));
    await notified();

    expect(panelParent.querySelectorAll(".card-conflict")).toHaveLength(2);
    expect(idA.ok).toBe(true);

    const resolveButton = panelParent.querySelector<HTMLButtonElement>(
      `.annotation-item[data-id="${idA.ok ? idA.id : ""}"] button[data-action="resolve"]`,
    );
    expect(resolveButton).not.toBeNull();
    resolveButton?.click();

    // A resolution is a proposal on the decisions channel (ADR-0018).
    expect(published).toHaveLength(1);
    expect(panelParent.querySelectorAll(".card-conflict")).toHaveLength(2);
    confirm(...published);
    applyDecisionEffects(contentDoc, annotationsDoc, log);
    await notified();

    expect(panelParent.querySelectorAll(".card-conflict")).toHaveLength(0);

    panel.destroy();
  });
});

describe("the panel by role (ADR-0019 §1)", () => {
  function panelFor(role: "read" | "suggest" | "edit") {
    const setup = setUp();
    createAnnotation(setup.contentDoc, setup.annotationsDoc, {
      type: "deletion",
      start: 0,
      end: 5,
      author: "bob",
    });
    createAnnotation(setup.contentDoc, setup.annotationsDoc, {
      type: "comment",
      start: 6,
      end: 11,
      author: "bob",
      body: "hm",
    });
    const panel = createAnnotationsPanel(
      setup.panelParent,
      setup.editor,
      setup.index,
      () => "alice",
      setup.decisions,
      () => {},
      role,
    );
    const actions = () =>
      Array.from(
        setup.panelParent.querySelectorAll("[data-action]"),
        (button) => button.getAttribute("data-action"),
      );
    return { ...setup, panel, actions };
  }

  // Creating goes through the selection toolbar, which a reader doesn't
  // get (selection-toolbar.test.ts).
  test("a reader decides nothing", () => {
    const { actions, panel } = panelFor("read");
    expect(actions()).toEqual([]);
    panel.destroy();
  });

  test("a reviewer neither decides nor resolves", () => {
    const { actions, panel } = panelFor("suggest");
    expect(actions()).toEqual([]);
    panel.destroy();
  });

  test("an editor decides and resolves", () => {
    const { actions, panel } = panelFor("edit");
    expect(actions().sort()).toEqual(["accept", "reject", "resolve"]);
    panel.destroy();
  });

  test("a confirmed decision not applied yet shows as waiting for an editor", async () => {
    const { panelParent, annotationsDoc, contentDoc, confirm, panel } =
      panelFor("read");
    const [deletion] = listAnnotations(contentDoc, annotationsDoc).filter(
      (annotation) => annotation.type === "deletion",
    );
    if (!deletion) throw new Error("no deletion");

    confirm(
      encodeProposal({
        proposalId: "p1",
        annotationId: deletion.id,
        decision: "accept",
        author: "carol",
      }),
    );
    await notified();

    const item = panelParent.querySelector(`[data-id="${deletion.id}"]`);
    expect(item?.textContent).toContain("accepted, waiting for an editor");
    panel.destroy();
  });

  test("to an editor, a confirmed acceptance not applied yet waits for the suggestion's text", async () => {
    const { panelParent, annotationsDoc, contentDoc, confirm, panel } =
      panelFor("edit");
    // A change made on a text this client has not received yet: its
    // acceptance cannot be applied until that text arrives.
    const ahead = contentDoc.fork();
    ahead.getText("content").insert(0, "later ");
    ahead.commit();
    const id = crypto.randomUUID();
    createAnnotation(
      contentDoc,
      annotationsDoc,
      {
        type: "addition",
        start: 0,
        end: 0,
        author: "bob",
        change: createDetachedChange(ahead, id, 3, "x"),
      },
      id,
    );

    confirm(
      encodeProposal({
        proposalId: "p1",
        annotationId: id,
        decision: "accept",
        author: "alice",
      }),
    );
    await notified();

    const item = panelParent.querySelector(`[data-id="${id}"]`);
    expect(item?.textContent).toContain("accepted, waiting for its text");
    panel.destroy();
  });
});
