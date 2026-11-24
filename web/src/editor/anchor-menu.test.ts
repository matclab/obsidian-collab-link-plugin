// The menu of a link to a heading (phase 20, decision 9): opened by a #
// typed right after `](` or `[[`, filtered by what follows, closed without
// changing the text; a choice replaces the typed #… by the heading, the
// link closed if it wasn't.
import { history, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type Transaction,
} from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { outlineOfText } from "../outline/outline.js";
import {
  anchorHeadings,
  anchorMenu,
  anchorState,
  chooseAnchor,
  closeAnchor,
  moveAnchor,
} from "./anchor-menu.js";
import { markdownSyntax } from "./markdown-syntax.js";
import { slashMenu, slashState } from "./slash-menu.js";

const PLAN = "# Mon titre\n\n## Relevé 19.0\n\n# Deux\n\n## Notes\n";

function start(text: string, at = text.length, plan = PLAN): EditorState {
  const headings = outlineOfText(plan);
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(at),
    extensions: [
      markdownSyntax(),
      history(),
      slashMenu(),
      anchorMenu(),
      anchorHeadings.of(() => headings),
    ],
  });
}

/** Typed by the user at the caret. */
function type(state: EditorState, text: string): EditorState {
  let next = state;
  for (const char of text) {
    const at = next.selection.main.head;
    next = next.update({
      changes: { from: at, insert: char },
      selection: { anchor: at + 1 },
      userEvent: "input.type",
    }).state;
  }
  return next;
}

const texts = (state: EditorState) =>
  anchorState(state)?.matches.map((each) => each.text);

function choose(state: EditorState): EditorState {
  const spec = chooseAnchor(state);
  if (!spec) throw new Error("closed");
  return state.update(spec).state;
}

describe("the menu of a link to a heading", () => {
  test("opened by a # right after ]( or [[, the headings offered", () => {
    expect(anchorState(type(start("[t]("), "#"))).toMatchObject({
      from: 4,
      form: "link",
      query: "",
    });
    expect(texts(type(start("[t]("), "#"))).toEqual([
      "Mon titre",
      "Relevé 19.0",
      "Deux",
      "Notes",
    ]);
    expect(anchorState(type(start("voir [["), "#"))).toMatchObject({
      from: 7,
      form: "wikilink",
    });
  });

  test("not elsewhere: a heading, a #tag, an embed, code", () => {
    expect(anchorState(type(start(""), "#"))).toBeNull();
    expect(anchorState(type(start("a"), "#"))).toBeNull();
    expect(anchorState(type(start("a ("), "#"))).toBeNull();
    expect(anchorState(type(start("![["), "#"))).toBeNull();
    expect(anchorState(type(start("`[t](  `", 5), "#"))).toBeNull();
  });

  test("not without headings", () => {
    expect(anchorState(type(start("[t](", 4, "texte\n"), "#"))).toBeNull();
    const none = EditorState.create({
      doc: "[t](",
      selection: EditorSelection.cursor(4),
      extensions: [markdownSyntax(), anchorMenu()],
    });
    expect(anchorState(type(none, "#"))).toBeNull();
  });

  test("filtered by what follows, spaces too; closed when nothing matches", () => {
    expect(texts(type(start("[t]("), "#relev"))).toEqual(["Relevé 19.0"]);
    expect(texts(type(start("[t]("), "#mon t"))).toEqual(["Mon titre"]);
    const none = type(start("[t]("), "#zz");
    expect(anchorState(none)).toBeNull();
    expect(none.doc.toString()).toBe("[t](#zz");
  });

  test("closed by what would end the link", () => {
    expect(anchorState(type(start("[t]("), "#mon)"))).toBeNull();
    expect(anchorState(type(start("[["), "#mon]"))).toBeNull();
    expect(anchorState(type(start("[["), "#mon|"))).toBeNull();
    expect(anchorState(type(start("[t]("), "#deux#"))).toBeNull();
  });

  test("closed by Escape, the caret out of #…, the # deleted; never the text changed", () => {
    const open = type(start("[t]("), "#mon");
    const escaped = open.update(closeAnchor(open)).state;
    expect(anchorState(escaped)).toBeNull();
    expect(escaped.doc.toString()).toBe("[t](#mon");
    const moved = open.update({ selection: { anchor: 2 } }).state;
    expect(anchorState(moved)).toBeNull();
    let deleted = open;
    for (let i = 0; i < 4; i++) {
      const at = deleted.selection.main.head;
      deleted = deleted.update({
        changes: { from: at - 1, to: at },
        userEvent: "delete.backward",
      }).state;
    }
    expect(anchorState(deleted)).toBeNull();
    expect(deleted.doc.toString()).toBe("[t](");
  });

  test("a choice: the heading as Obsidian writes it, the link closed, the caret after", () => {
    const link = choose(type(start("[t]("), "#mon"));
    expect(link.doc.toString()).toBe("[t](#Mon%20titre)");
    expect(link.selection.main.head).toBe(link.doc.length);
    expect(anchorState(link)).toBeNull();
    const wikilink = choose(type(start("voir [["), "#rel"));
    expect(wikilink.doc.toString()).toBe("voir [[#Relevé 19.0]]");
    expect(wikilink.selection.main.head).toBe(wikilink.doc.length);
  });

  test("a link already closed after the caret: not closed twice", () => {
    const link = choose(type(start("[t]() et", 4), "#deux"));
    expect(link.doc.toString()).toBe("[t](#Deux) et");
    expect(link.selection.main.head).toBe(10);
    const wikilink = choose(type(start("[[]]", 2), "#notes"));
    expect(wikilink.doc.toString()).toBe("[[#Notes]]");
  });

  test("the arrows choose another; one undo gives the typed #… back", () => {
    const open = type(start("[t]("), "#");
    const down = open.update(moveAnchor(open, 1)).state;
    expect(anchorState(down)?.active).toBe(1);
    const up = open.update(moveAnchor(open, -1)).state;
    expect(anchorState(up)?.active).toBe(3);
    const chosen = choose(down);
    expect(chosen.doc.toString()).toBe("[t](#Relevé%2019.0)");
    let back: EditorState = chosen;
    undo({
      state: back,
      dispatch: (tr: Transaction) => {
        back = tr.state;
      },
    });
    expect(back.doc.toString()).toBe("[t](#");
  });

  test("the / menu stays closed while it is open", () => {
    const both = type(start("[t]("), "#mon /");
    expect(anchorState(both)).not.toBeNull();
    expect(slashState(both)).toBeNull();
  });
});
