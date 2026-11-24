// The / menu's logic (phase 20c, ADR-0046 §4): opened by a / typed at a
// line's start or after a space, filtered by what follows, closed without
// changing the text; a choice replaces the typed /… and nothing else.
import { undo } from "@codemirror/commands";
import { history } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { afterEach, describe, expect, test } from "vitest";
import { setLanguage } from "../i18n/index.js";
import { CALLOUT_FAMILIES } from "../render/index.js";
import { markdownSyntax } from "./markdown-syntax.js";
import {
  chooseSlash,
  closeSlash,
  moveSlash,
  slashMatches,
  slashMenu,
  slashState,
} from "./slash-menu.js";

function start(text: string, at = text.length): EditorState {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(at),
    extensions: [markdownSyntax(), history(), slashMenu()],
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

describe("the / menu", () => {
  test("opened by a / at a line's start or after a space", () => {
    expect(slashState(type(start(""), "/"))?.from).toBe(0);
    expect(slashState(type(start("a "), "/"))?.from).toBe(2);
    expect(slashState(type(start("a"), "/"))).toBeNull();
    // In code, a / is text.
    expect(slashState(type(start("`a  b`", 3), "/"))).toBeNull();
    expect(slashState(type(start("```\n\n```", 4), "/"))).toBeNull();
  });

  test("filtered by what follows, closed when nothing matches", () => {
    const open = type(start(""), "/tab");
    expect(slashState(open)?.matches).toEqual(["table"]);
    const path = type(start(""), "/home/moi");
    expect(slashState(path)).toBeNull();
    expect(path.doc.toString()).toBe("/home/moi");
    // A space right after the /: a / in the text (found by the order
    // scenario: "/ " kept it open, every name with a space matching).
    expect(slashState(type(start(""), "/ "))).toBeNull();
  });

  test("closed by Escape, the caret out of /…, the / deleted; never the text changed", () => {
    const open = type(start("x "), "/ti");
    const closed = open.update(closeSlash(open)).state;
    expect(slashState(closed)).toBeNull();
    expect(closed.doc.toString()).toBe("x /ti");
    const away = open.update({
      selection: { anchor: 0 },
      userEvent: "select",
    }).state;
    expect(slashState(away)).toBeNull();
    // Forward over text already there, which the user didn't type
    // (found by the order scenario: `/` then the caret after `x`).
    const before = type(start("x", 0), "/");
    const over = before.update({
      selection: { anchor: 2 },
      userEvent: "select",
    }).state;
    expect(over.doc.toString()).toBe("/x");
    expect(slashState(over)).toBeNull();
    const deleted = open.update({
      changes: { from: 2, to: 5 },
      userEvent: "delete",
    }).state;
    expect(slashState(deleted)).toBeNull();
  });

  test("another's edit: before the / it follows, in /… it closes", () => {
    const open = type(start("x "), "/ta");
    const remote = (from: number, insert: string) =>
      open.update({
        changes: { from, insert },
        annotations: [
          Transaction.remote.of(true),
          Transaction.addToHistory.of(false),
        ],
      }).state;
    expect(slashState(remote(0, "yy"))?.from).toBe(4);
    expect(slashState(remote(3, "z"))).toBeNull();
    // In /…, even what still matches: a choice would take another's text.
    const ble = type(start("x "), "/ble");
    const inside = ble.update({
      changes: { from: 3, insert: "ta" },
      annotations: [Transaction.remote.of(true)],
    }).state;
    expect(inside.doc.toString()).toBe("x /table");
    expect(slashState(inside)).toBeNull();
  });

  test("the arrows move the choice among the matches", () => {
    const open = type(start(""), "/head");
    expect(slashState(open)?.active).toBe(0);
    const down = open.update(moveSlash(open, 1)).state;
    expect(slashState(down)?.active).toBe(1);
    const up = down.update(moveSlash(down, -2)).state;
    expect(slashState(up)?.active).toBe(
      (slashState(open)?.matches.length ?? 0) - 1,
    );
  });

  test("a choice replaces the typed /… in one transaction; undo gives it back", () => {
    const open = type(start("a\n"), "/tab");
    const spec = chooseSlash(open);
    expect(spec).not.toBeNull();
    const chosen = open.update(spec ?? {}).state;
    expect(chosen.doc.toString()).toBe("a\n\n|  |  |\n| --- | --- |\n|  |  |");
    expect(slashState(chosen)).toBeNull();
    let back = chosen;
    undo({
      state: chosen,
      dispatch: (tr) => {
        back = tr.state;
      },
    });
    expect(back.doc.toString()).toBe("a\n/tab");
  });

  test("a line construct or an inline one, at the caret's place", () => {
    const heading = type(start("Title "), "/head");
    const h = heading.update(chooseSlash(heading) ?? {}).state;
    expect(h.doc.toString()).toBe("# Title ");
    const bold = type(start("a "), "/bold");
    const b = bold.update(chooseSlash(bold) ?? {}).state;
    expect(b.doc.toString()).toBe("a ****");
    expect(b.selection.main.head).toBe(4);
  });

  // Found on 2026-10-30 by slash-menu.order.property.test.ts, whose check
  // wanted what follows the /… in one piece: a block goes after the
  // top-level block of the caret (phase 20, decision 2), here between the
  // heading's line and what follows it.
  test("a block typed before a line's text: after that block, the text kept in order", () => {
    const open = type(start("# t\n\nab", 0), "/math");
    const chosen = open.update(chooseSlash(open) ?? {}).state;
    expect(chosen.doc.toString()).toBe("# t\n\n$$\nx^2\n$$\n\nab");
  });
});

// ADR-0063: a callout's families, offered when looked for (EN1, EN2),
// inserted with a title in the page's language (EN3).
describe("the / menu's callouts", () => {
  afterEach(() => setLanguage("en"));
  const families = CALLOUT_FAMILIES.map((family) => `callout:${family}`);

  test("no family without a filter; all after Callout when it is the only construction left (EN1, EN2)", () => {
    expect(slashMatches("").some((item) => item.startsWith("callout:"))).toBe(
      false,
    );
    expect(slashMatches("callout")).toEqual(["callout", ...families]);
    setLanguage("fr");
    expect(slashMatches("enc")).toEqual(["callout", ...families]);
  });

  test("a family found by a word of its name, its word or Obsidian's other words starting with the filter, from two letters, where Callout is in the list (EN2)", () => {
    setLanguage("fr");
    const families = (query: string) =>
      slashMatches(query).filter((item) => item.startsWith("callout:"));
    for (const query of ["astuce", "Tip", "hint", "important"])
      expect(slashMatches(query)).toEqual(["callout:tip"]);
    // Constructions still found inside a word: « Gras », « bas de page ».
    expect(families("as")).toEqual(["callout:tip"]);
    expect(slashMatches("attention")).toEqual(["callout:warning"]);
    expect(slashMatches("faire")).toEqual(["callout:todo"]);
    // Inside a word: no.
    expect(families("te")).toEqual([]);
    // One letter: no family, many constructions left already.
    expect(families("a")).toEqual([]);
    expect(families("e")).toEqual([]);
    // Callout's place in the catalogue: after a quote, before a footnote.
    expect(slashMatches("cita")).toEqual(["quote", "callout:quote"]);
    expect(slashMatches("note")).toEqual(["callout:note", "footnote"]);
    setLanguage("en");
    // Callout the only construction left from two letters in English.
    expect(slashMatches("ca")).toEqual([
      "callout",
      ...CALLOUT_FAMILIES.map((family) => `callout:${family}`),
    ]);
    // One letter no construction has: the families it starts, else the
    // menu would close before « /warning » is typed.
    expect(slashMatches("w")).toEqual(["callout:warning"]);
  });

  test("inserted with its title in the page's language, none when it is Obsidian's own (EN3)", () => {
    const insert = (query: string) => {
      const open = type(start("a\n"), `/${query}`);
      return open.update(chooseSlash(open) ?? {}).state;
    };
    expect(insert("warning").doc.toString()).toBe("a\n\n> [!warning]\n> ");
    setLanguage("fr");
    const warning = insert("attention");
    expect(warning.doc.toString()).toBe("a\n\n> [!warning] Attention\n> ");
    expect(warning.selection.main.head).toBe(warning.doc.length);
    expect(insert("astuce").doc.toString()).toBe("a\n\n> [!tip] Astuce\n> ");
    // Its title in French is Obsidian's: none.
    expect(insert("note").doc.toString()).toBe("a\n\n> [!note]\n> ");
    // Callout alone, as before.
    expect(insert("encadré").doc.toString()).toBe("a\n\n> [!note]\n> ");
  });

  test("a family chosen: one transaction, undo gives the /… back (EN4)", () => {
    setLanguage("fr");
    const open = type(start("a\n"), "/atten");
    const chosen = open.update(chooseSlash(open) ?? {}).state;
    let back = chosen;
    undo({
      state: chosen,
      dispatch: (tr) => {
        back = tr.state;
      },
    });
    expect(back.doc.toString()).toBe("a\n/atten");
  });
});
