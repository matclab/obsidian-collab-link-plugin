// @vitest-environment jsdom
// A `[[B]]` written in a linked note's editor, B a linked note
// (docs/phase-19-liens.md, decision 3; LK6): once complete and the caret
// out of it, written as B's address, as its own step in the history; only
// for what the person wrote, never for another's text.
import { history, undo } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { typedLinks } from "./typed-links.js";

const ORIGIN = "https://collab.test";
const ADDRESS = `${ORIGIN}/?doc=b`;
const resolve = (path: string) =>
  path === "B" ? { documentId: "b", base: `${ORIGIN}/` } : undefined;

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function setUp(doc = "") {
  const view = new EditorView({
    doc,
    extensions: [history(), typedLinks(() => resolve)],
    parent: document.body,
  });
  views.push(view);
  return view;
}

const microtasks = () => new Promise<void>((done) => queueMicrotask(done));

/** Typed at the caret, as a keystroke is. */
function type(view: EditorView, text: string) {
  const { head } = view.state.selection.main;
  view.dispatch({
    changes: { from: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: "input.type",
  });
}

describe("a [[…]] to a linked note, typed", () => {
  test("a suggestion accepted (the whole link, the caret after it): converted", async () => {
    const view = setUp("Vers [[B");
    view.dispatch({
      changes: { from: 5, to: 8, insert: "[[B]]" },
      selection: { anchor: 10 },
      userEvent: "input",
    });
    await microtasks();
    expect(view.state.doc.toString()).toBe(`Vers [B](${ADDRESS})`);
  });

  // Found in the real Obsidian (phase 19c.7): a transaction of its own
  // right after the suggestion accepted, which changes neither the text
  // nor the selection; the link stayed as written.
  test("a suggestion accepted, then another transaction at once: converted all the same", async () => {
    const view = setUp("Vers [[B");
    view.dispatch({
      changes: { from: 5, to: 8, insert: "[[B]]" },
      selection: { anchor: 10 },
      userEvent: "input",
    });
    view.dispatch({ scrollIntoView: true });
    await microtasks();
    expect(view.state.doc.toString()).toBe(`Vers [B](${ADDRESS})`);
  });

  test("typed by hand, the brackets closed ahead: converted once the caret leaves it", async () => {
    const view = setUp("Vers ");
    view.dispatch({ selection: { anchor: 5 } });
    type(view, "[[]]");
    view.dispatch({ selection: { anchor: 7 } });
    type(view, "B");
    await microtasks();
    expect(view.state.doc.toString()).toBe("Vers [[B]]");
    view.dispatch({ selection: { anchor: 10 } });
    await microtasks();
    expect(view.state.doc.toString()).toBe(`Vers [B](${ADDRESS})`);
  });

  test("undone: the [[B]] back, not converted again", async () => {
    const view = setUp("Vers [[B");
    view.dispatch({
      changes: { from: 5, to: 8, insert: "[[B]]" },
      selection: { anchor: 10 },
      userEvent: "input",
    });
    await microtasks();
    undo(view);
    await microtasks();
    expect(view.state.doc.toString()).toBe("Vers [[B]]");
  });

  test("another's text, a link to a note not linked, one untouched: left as written", async () => {
    const view = setUp("Déjà [[B]] ici ");
    view.dispatch({
      changes: { from: 15, insert: "[[B]]" },
      annotations: Transaction.remote.of(true),
    });
    view.dispatch({ selection: { anchor: 0 } });
    await microtasks();
    expect(view.state.doc.toString()).toBe("Déjà [[B]] ici [[B]]");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    type(view, " [[C]]");
    await microtasks();
    expect(view.state.doc.toString()).toBe("Déjà [[B]] ici [[B]] [[C]]");
  });
});
