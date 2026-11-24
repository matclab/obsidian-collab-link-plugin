// The Tab key in the page's editor (ADR-0054): indent, as Obsidian does.
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { indentChange } from "./list-indent.js";
import { markdownSyntax } from "./markdown-syntax.js";

/** `text` with its selection written in it: `|` a caret, `[…]` a range. */
function stateOf(text: string): EditorState {
  const caret = text.indexOf("|");
  const from = caret >= 0 ? caret : text.indexOf("[");
  const doc = text.replace(/[|[\]]/g, "");
  const to = caret >= 0 ? caret : text.indexOf("]") - 1;
  return EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: markdownSyntax(),
  });
}

/** The text after Tab (1) or Shift+Tab (-1); null when nothing changes. */
function press(text: string, by: 1 | -1): string | null {
  const state = stateOf(text);
  const spec = indentChange(state, by);
  return spec ? state.update(spec).state.doc.toString() : null;
}

describe("in a list (ADR-0054 §1)", () => {
  test("Tab makes an item the child of the one before, its children with it", () => {
    expect(press("- a\n- b|", 1)).toBe("- a\n\t- b");
    expect(press("- a\n- b|\n\t- c\n- d", 1)).toBe("- a\n\t- b\n\t\t- c\n- d");
    // From a line that continues the item.
    expect(press("- a\n- b\n  more|", 1)).toBe("- a\n\t- b\n\t  more");
  });

  test("the first item of its list has nothing to go under: unchanged", () => {
    expect(press("- a|\n- b", 1)).toBeNull();
    expect(press("- a\n\t- b|", 1)).toBeNull();
  });

  test("Shift+Tab takes it one level up, its children with it", () => {
    expect(press("- a\n\t- b|", -1)).toBe("- a\n- b");
    expect(press("- a\n\t- b|\n\t\t- c", -1)).toBe("- a\n- b\n\t- c");
    expect(press("- a\n  - b|", -1)).toBe("- a\n- b");
    expect(press("1. a\n   1. b|", -1)).toBe("1. a\n1. b");
  });

  test("an item of the first level stays", () => {
    expect(press("- a\n- b|", -1)).toBeNull();
  });

  test("a numbered item that starts a list under its sibling starts at 1", () => {
    // « 2. » cannot interrupt the paragraph of « a »: it would be text.
    expect(press("1. a\n2. b|", 1)).toBe("1. a\n\t1. b");
    expect(press("1. a\n\t1. b\n2. c|", 1)).toBe("1. a\n\t1. b\n\t2. c");
    // Up, the first of those after it, now its children.
    expect(press("1. a\n\t1. b|\n\t2. c", -1)).toBe("1. a\n1. b\n\t1. c");
    // `1)` then `2.`: two lists, the second's first just as well.
    expect(press("1. a\n\t1) b|\n\t2. c", -1)).toBe("1. a\n1) b\n\t1. c");
  });

  test("in a quote, after its marks", () => {
    expect(press("> - a\n> - b|", 1)).toBe("> - a\n> \t- b");
    expect(press("> - a\n> \t- b|", -1)).toBe("> - a\n> - b");
  });
});

describe("lines selected (ADR-0054 §2)", () => {
  test("Tab indents each one, Shift+Tab takes a level off", () => {
    expect(press("[a\nb]", 1)).toBe("\ta\n\tb");
    expect(press("[\ta\n    b\n  c]", -1)).toBe("a\nb\nc");
  });

  test("an item selected takes its children along; blank lines stay blank", () => {
    expect(press("[- a\n\n- b]\n\t- c", 1)).toBe("\t- a\n\n\t- b\n\t\t- c");
  });
});

describe("elsewhere (ADR-0054 §3)", () => {
  test("Tab inserts a tab at the caret; Shift+Tab takes a level off the line", () => {
    expect(press("ab|c", 1)).toBe("ab\tc");
    expect(press("\tabc|", -1)).toBe("abc");
    expect(press("    abc|", -1)).toBe("abc");
    expect(press("abc|", -1)).toBeNull();
  });
});

/** Found by the property (list-indent.property.test.ts), kept. */
describe("counterexamples of the property", () => {
  test("in a quote, a tab short of a number's text: spaces", () => {
    // After `> `, a tab stops at column 4; `1. `'s text is at 5.
    expect(press("> 1. w0\n> 1. w1|", 1)).toBe("> 1. w0\n>    1. w1");
  });

  test("a quote's blank line stays as it is", () => {
    expect(press("> - w0\n> 1. w1\n> 1. w2|\n>\n> - w3", 1)).toBe(
      "> - w0\n> 1. w1\n>    1. w2\n>\n> - w3",
    );
  });

  test("a tab taken off moves the next one: the shortest start taken", () => {
    const text = "> - w0\n> - w1\n> \t- w2\n> \t- w3";
    expect(press("> - w0\n> - w1\n> \t- w2\n> \t\t- w3|", -1)).toBe(text);
  });

  test("measured at the marks, where a quote takes part of a tab", () => {
    const text = "> - w0\n> 1. w1\n> \t- w2\n> \t- w3";
    expect(press(`${text}|`, 1)).toBe("> - w0\n> 1. w1\n> \t- w2\n> \t\t- w3");
    expect(press("> - w0\n> 1. w1\n> \t- w2\n> \t\t- w3|", -1)).toBe(text);
  });

  test("up, the items after it become its children: the first at 1", () => {
    expect(press("1. w0\n\t1. w1|\n\t2. w2", -1)).toBe("1. w0\n1. w1\n\t1. w2");
  });

  test("admitted: a number under a bullet, which the two parsers read apart", () => {
    // The editor's parser reads `2. w2` as w1's text (CommonMark),
    // markdown-it as a list (ADR-0054, Conséquences).
    expect(press("1. w0\n\t- w1|\n2. w2", -1)).toBe("1. w0\n- w1\n2. w2");
  });
});
