// @vitest-environment jsdom
// Links in the editor (phase 11, decision 9): a click places the caret;
// Ctrl/Cmd+click opens a link that leaves the document in a new tab, with
// the preview's rules; never a link that would replace the fragment, which
// holds the key (ADR-0021 §3).
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { forceParsing } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDocumentEditor } from "./editor.js";
import { anchorFollowers, hrefAt } from "./link-click.js";
import { withoutLayout } from "./test-support/no-layout.js";

function hrefOf(text: string, pos: number): string | null {
  const state = EditorState.create({ doc: text, extensions: [markdown()] });
  const tree = ensureSyntaxTree(state, text.length, 5000);
  if (!tree) throw new Error("not parsed");
  return hrefAt(tree, state.doc, pos);
}

describe("hrefAt", () => {
  const text = 'Voir [le site](https://x.org "t") ou <https://y.org> et [ref].';

  test("the address of the link under a position, on its text or its markup", () => {
    expect(hrefOf(text, text.indexOf("site"))).toBe("https://x.org");
    expect(hrefOf(text, text.indexOf("x.org"))).toBe("https://x.org");
    expect(hrefOf(text, text.indexOf("y.org"))).toBe("https://y.org");
  });

  test("none outside a link, nor for a reference link", () => {
    expect(hrefOf(text, 1)).toBeNull();
    expect(hrefOf(text, text.indexOf("ref"))).toBeNull();
  });
});

describe("Ctrl/Cmd+click in the editor", () => {
  // A footnote's way there and back scrolls.
  const scrolled = withoutLayout();
  const parents: Element[] = [];
  afterEach(() => {
    for (const parent of parents.splice(0)) parent.remove();
  });

  function setUp(text: string, at: number) {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, text);
    doc.commit();
    const parent = document.createElement("div");
    document.body.append(parent);
    parents.push(parent);
    const opened: string[] = [];
    const { view } = createDocumentEditor(parent, doc, {
      livePreview: true,
      openLink: (url) => opened.push(url),
    });
    scrolled(view);
    // Parsed to the end: under load, the parser stops at its time budget.
    forceParsing(view, view.state.doc.length, 5000);
    // jsdom has no layout: the position under the pointer is given.
    view.posAtCoords = vi.fn(() => at) as typeof view.posAtCoords;
    const click = (init: MouseEventInit) =>
      view.contentDOM.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    return { view, opened, click };
  }

  test("opens a link that leaves the document, and moves nothing", () => {
    const text = "Voir [le site](https://x.org).";
    const { view, opened, click } = setUp(text, 7);
    const before = view.state.selection;
    click({ ctrlKey: true });
    click({ metaKey: true });
    expect(opened).toEqual(["https://x.org", "https://x.org"]);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  test("a plain click opens nothing", () => {
    const { opened, click } = setUp("Voir [le site](https://x.org).", 7);
    click({});
    expect(opened).toEqual([]);
  });

  test("an in-document link goes to whoever follows anchors, decoded, the fragment untouched (phase 19, decision 8)", () => {
    window.location.hash = "#k=key&s=secret";
    const text = "[a](#Mon%20titre) [b](<#Mon titre>) [c](#%E0) [d](#)";
    const at = (s: string) => text.indexOf(s) + 1;
    for (const [where, wanted] of [
      ["a]", "Mon titre"],
      ["b]", "Mon titre"],
      ["c]", "%E0"],
    ] as const) {
      const { view, opened, click } = setUp(text, at(where));
      const followed: string[] = [];
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          anchorFollowers.of((id) => followed.push(id)),
        ),
      });
      click({});
      expect(followed).toEqual([]);
      const before = view.state.selection;
      click({ ctrlKey: true });
      expect(followed, where).toEqual([wanted]);
      expect(opened).toEqual([]);
      expect(view.state.selection.eq(before)).toBe(true);
    }
    const { view, click } = setUp(text, at("d]"));
    const followed: string[] = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        anchorFollowers.of((id) => followed.push(id)),
      ),
    });
    click({ ctrlKey: true });
    expect(followed).toEqual([]);
    expect(window.location.hash).toBe("#k=key&s=secret");
  });

  test("a [[…]] to a heading goes to whoever follows anchors; to a note, nowhere (phase 19)", () => {
    const text = "[[#Mon titre|ici]] [[#P#E]] [[Note]]";
    const at = (s: string) => text.indexOf(s) + 1;
    const followedAt = (pos: number) => {
      const { view, opened, click } = setUp(text, pos);
      const followed: string[] = [];
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          anchorFollowers.of((id) => followed.push(id)),
        ),
      });
      click({ ctrlKey: true });
      expect(opened).toEqual([]);
      return followed;
    };
    expect(followedAt(at("ici"))).toEqual(["Mon titre"]);
    expect(followedAt(at("[[#Mon"))).toEqual(["Mon titre"]);
    expect(followedAt(at("P#E"))).toEqual(["P#E"]);
    expect(followedAt(at("Note"))).toEqual([]);
  });

  test("a footnote's reference leads to its text, its label back to the first reference (phase 20, decision 8)", () => {
    const text = "Une phrase[^1], encore[^1].\n\n[^1]: La note.\n";
    const reference = setUp(text, text.indexOf("1]"));
    reference.click({ ctrlKey: true });
    expect(reference.view.state.selection.main.head).toBe(
      text.indexOf("La note"),
    );
    expect(reference.opened).toEqual([]);
    const label = setUp(text, text.indexOf("[^1]:") + 1);
    label.click({ metaKey: true });
    expect(label.view.state.selection.main.empty).toBe(true);
    expect(label.view.state.selection.main.head).toBe(text.indexOf("[^1]") + 4);
  });

  test("never a link the preview refuses, nor one inside the document", () => {
    for (const href of ["javascript:alert(1)", "#titre", "page.md"]) {
      const { opened, click } = setUp(`[x](${href})`, 1);
      click({ ctrlKey: true });
      expect(opened).toEqual([]);
    }
  });
});
