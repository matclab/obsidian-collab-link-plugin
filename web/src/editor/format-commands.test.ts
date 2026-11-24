// The formatting commands (phase 20, decision 2): what the toolbar, the
// shortcuts and the / menu do to the text. Texts are written with the
// selection between ⟨ and ⟩, a caret as ‸.
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import type { ConstructId } from "./constructs.js";
import {
  activeConstructs,
  constructTransaction,
  paragraphForm,
} from "./format-commands.js";
import { markdownSyntax } from "./markdown-syntax.js";

function stateOf(marked: string): EditorState {
  let text = "";
  let anchor = -1;
  let head = -1;
  for (const char of marked) {
    if (char === "⟨") anchor = text.length;
    else if (char === "⟩") head = text.length;
    else if (char === "‸") anchor = head = text.length;
    else text += char;
  }
  if (anchor < 0 || head < 0) throw new Error(`no selection in ${marked}`);
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdownSyntax()],
  });
}

function marked(state: EditorState): string {
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  if (from === to) return `${text.slice(0, from)}‸${text.slice(from)}`;
  return `${text.slice(0, from)}⟨${text.slice(from, to)}⟩${text.slice(to)}`;
}

function apply(id: ConstructId, text: string): string | null {
  const state = stateOf(text);
  const spec = constructTransaction(state, id);
  return spec ? marked(state.update(spec).state) : null;
}

describe("inline constructs", () => {
  test("wrap the selection, which stays on the text", () => {
    expect(apply("bold", "a ⟨b⟩ c")).toBe("a **⟨b⟩** c");
  });

  test("unwrap a selection already in the construct", () => {
    expect(apply("bold", "a **⟨b⟩** c")).toBe("a ⟨b⟩ c");
    expect(apply("italic", "a *x⟨b⟩y* c")).toBe("a x⟨b⟩y c");
  });

  test("leave the spaces at the selection's edges outside", () => {
    // `** b **` would not be bold; the selection stays the user's.
    expect(apply("bold", "a⟨ b ⟩c")).toBe("a⟨ **b** ⟩c");
    expect(apply("bold", "a⟨ **b** ⟩c")).toBe("a⟨ b ⟩c");
    expect(apply("bold", "a⟨  ⟩c")).toBeNull();
  });

  test("without a selection, put the marks around the caret, and take them back", () => {
    expect(apply("bold", "a ‸ c")).toBe("a **‸** c");
    expect(apply("bold", "a **‸** c")).toBe("a ‸ c");
    expect(apply("strikethrough", "a ~~‸~~ c")).toBe("a ‸ c");
  });

  test("never marks that pair with others (counter-examples found by the properties)", () => {
    // `=~~~~=~~` would strike the `=`.
    expect(apply("strikethrough", "=‸=~~")).toBeNull();
    expect(apply("code", "‸=``")).toBeNull();
    // `=__=**==__**__`: the underscores pair anew around the marks.
    expect(apply("bold", "=__=⟨==__⟩__")).toBeNull();
    // `*=**=*` is one emphasis: taken off, `=*‸*=` would read as empty
    // marks, still on.
    expect(apply("italic", "*=*‸*=*")).toBeNull();
  });

  test("next to punctuation, to the words' edges", () => {
    expect(apply("bold", "a⟨.⟩bc d")).toBe("**a⟨.⟩bc** d");
  });

  test("with the caret in the construct, unwrap it", () => {
    expect(apply("bold", "a **b‸c** d")).toBe("a b‸c d");
  });
});

describe("line constructs", () => {
  test("a heading: put, changed to another level, taken off", () => {
    expect(apply("heading2", "a‸b")).toBe("## a‸b");
    expect(apply("heading2", "# a‸b")).toBe("## a‸b");
    expect(apply("heading2", "## a‸b")).toBe("a‸b");
    expect(apply("paragraph", "### a‸b")).toBe("a‸b");
  });

  test("a list on every line touched, the selection still on the text", () => {
    expect(apply("bulletList", "⟨a\nb⟩")).toBe("- ⟨a\n- b⟩");
    expect(apply("bulletList", "- ⟨a\n- b⟩")).toBe("⟨a\nb⟩");
    expect(apply("bulletList", "- ⟨a\nb⟩")).toBe("- ⟨a\n- b⟩");
    expect(apply("bulletList", "1. a‸")).toBe("- a‸");
    expect(apply("orderedList", "⟨a\n\nb\nc⟩")).toBe("1. ⟨a\n\n2. b\n3. c⟩");
    expect(apply("taskList", "- a‸")).toBe("- [ ] a‸");
    expect(apply("taskList", "- [x] a‸")).toBe("a‸");
    expect(apply("bulletList", "  - [x] a‸")).toBe("  - a‸");
    expect(apply("bulletList", "- a\n  - b‸")).toBe("- a\n\nb‸");
  });

  test("out of a list or a quote, a line between, or it would stay in it", () => {
    // `- a\nb`: b would be the item's lazy continuation.
    expect(apply("bulletList", "- a\n- b‸")).toBe("- a\n\nb‸");
    expect(apply("quote", "> a\n> b‸")).toBe("> a\n\nb‸");
    expect(apply("bulletList", "> - a\n> - b‸")).toBe("> - a\n>\n> b‸");
  });

  test("a list marker only where the parser reads one", () => {
    // `2)` can't interrupt a paragraph: the line continues it.
    expect(apply("heading1", "a\n2) b‸")).toBe("a\n# 2) b‸");
    // `- 2) b` would be a numbered list in the bullet: refused.
    expect(apply("bulletList", "a\n2) b‸")).toBeNull();
  });

  test("not the line the selection ends at the start of", () => {
    expect(apply("bulletList", "⟨a\n⟩b")).toBe("- ⟨a\n⟩b");
  });

  test("a quote, blank lines included, one level taken off", () => {
    expect(apply("quote", "⟨a\n\nb⟩")).toBe("> ⟨a\n>\n> b⟩");
    expect(apply("quote", "> > ⟨a\n> b⟩")).toBe("> ⟨a\nb⟩");
  });

  test("on a blank line, the markup alone, the caret after it", () => {
    expect(apply("heading2", "‸")).toBe("## ‸");
    expect(apply("heading1", "a\n‸\nb")).toBe("a\n# ‸\nb");
    expect(apply("bulletList", "- a\n‸")).toBe("- a\n- ‸");
    expect(apply("taskList", "‸")).toBe("- [ ] ‸");
    expect(apply("bulletList", "- ‸")).toBe("‸");
    expect(apply("heading2", "## ‸")).toBe("‸");
    // Text after a blank line is never a no-op.
    expect(apply("paragraph", "‸")).toBeNull();
  });

  test("on a blank line under a paragraph, a line between if needed", () => {
    // `a\n- ` is a setext heading, `a\n1. ` the paragraph continued.
    expect(apply("bulletList", "a\n‸")).toBe("a\n\n- ‸");
    expect(apply("orderedList", "a\n‸")).toBe("a\n\n1. ‸");
    expect(apply("heading1", "a\n‸")).toBe("a\n# ‸");
    // Above a paragraph, `- [ ] x\nb` would take `b` in the item, once
    // typed in (found by the property).
    expect(apply("taskList", "‸\nb")).toBe("- [ ] ‸\n\nb");
    expect(apply("heading1", "‸\nb")).toBe("# ‸\nb");
  });

  test("blank lines among others are left as they are", () => {
    expect(apply("bulletList", "⟨a\n\nb⟩")).toBe("- ⟨a\n\n- b⟩");
    expect(apply("bulletList", "⟨\n⟩")).toBeNull();
  });

  test("a caret at a line's start stays a caret, after the markup", () => {
    expect(apply("heading2", "‸ab")).toBe("## ‸ab");
    expect(apply("bulletList", "‸ab")).toBe("- ‸ab");
  });

  test("not in a code block, a formula or the YAML header", () => {
    expect(apply("heading1", "⟨a\n```\nb\n```\nc⟩")).toBe(
      "# ⟨a\n```\nb\n```\n# c⟩",
    );
    expect(apply("bulletList", "```\nb‸\n```")).toBeNull();
  });
});

describe("block constructs", () => {
  test("on a blank line, there, a blank line around it", () => {
    expect(apply("rule", "‸")).toBe("***‸");
    expect(apply("codeBlock", "a\n\n‸\n\nb")).toBe("a\n\n```\n‸\n```\n\nb");
    expect(apply("codeBlock", "a\n‸\nb")).toBe("a\n\n```\n‸\n```\n\nb");
  });

  test("after the block the caret is in, never in it", () => {
    expect(apply("table", "a‸b\nc\n\nd")).toBe(
      "ab\nc\n\n| ‸ |  |\n| --- | --- |\n|  |  |\n\nd",
    );
    expect(apply("rule", "- a‸\n- b")).toBe("- a\n- b\n\n***‸");
    expect(apply("callout", "```\nx‸\n```")).toBe(
      "```\nx\n```\n\n> [!note]\n> ‸",
    );
    expect(apply("mathBlock", "# T‸\ntext")).toBe(
      "# T\n\n$$\n⟨x^2⟩\n$$\n\ntext",
    );
    expect(apply("rule", "```\n‸\n```")).toBe("```\n\n```\n\n***‸");
    expect(apply("rule", "- a\n‸\n- b")).toBe("- a\n\n- b\n\n***‸");
  });

  // An HTML block's tags parsed as HTML had a `Document` of their own,
  // where the walk up to the top-level block stopped: the block was cut
  // after its first element (docs/taille-du-bundle.md, piste 1).
  test("after an HTML block, never between its elements", () => {
    expect(apply("rule", "<p>a‸</p>\n<p>b</p>\nc")).toBe(
      "<p>a</p>\n<p>b</p>\nc\n\n***‸",
    );
    expect(apply("rule", "x <b>y‸</b> z\n\nw")).toBe(
      "x <b>y</b> z\n\n***‸\n\nw",
    );
  });
});

describe("a link", () => {
  test("around the selection, the caret where the address goes", () => {
    expect(apply("link", "a ⟨b⟩ c")).toBe("a [b](‸) c");
    expect(apply("link", "a ‸ c")).toBe("a [‸]() c");
  });

  test("a selected address goes in the parentheses, the caret in the text", () => {
    expect(apply("link", "see ⟨https://example.org/a⟩")).toBe(
      "see [‸](https://example.org/a)",
    );
  });

  test("in a link, its address selected", () => {
    expect(apply("link", "[b‸](https://x.org)")).toBe("[b](⟨https://x.org⟩)");
    expect(apply("link", "[b](ht‸tps://x.org)")).toBe("[b](⟨https://x.org⟩)");
  });

  test("not where a link would not read", () => {
    expect(apply("link", "`a⟨b⟩c`")).toBeNull();
    expect(apply("link", "⟨a\n\nb⟩")).toBeNull();
  });
});

describe("a footnote", () => {
  test("its reference at the caret, its text at the end, the caret there", () => {
    expect(apply("footnote", "a‸ b")).toBe("a[^1] b\n\n[^1]: ‸");
    expect(apply("footnote", "a[^1]‸ b\n\n[^1]: x\n")).toBe(
      "a[^1][^2] b\n\n[^1]: x\n\n[^2]: ‸",
    );
  });
});

describe("what is on at the selection (the toolbar's state)", () => {
  const on = (text: string) => [...activeConstructs(stateOf(text))].sort();

  test("the inline constructs and the lines' forms around it", () => {
    expect(on("a **b *c‸* d**")).toEqual(["bold", "italic", "paragraph"]);
    expect(on("- [ ] a ~~b‸~~")).toEqual([
      "paragraph",
      "strikethrough",
      "taskList",
    ]);
    expect(on("> ## a‸")).toEqual(["heading2", "quote"]);
    expect(on("```\n**a‸**\n```")).toEqual([]);
  });

  test("the paragraph's form: a heading's level, a quote, text, or mixed", () => {
    expect(paragraphForm(stateOf("### a‸"))).toBe("heading3");
    expect(paragraphForm(stateOf("> a‸"))).toBe("quote");
    expect(paragraphForm(stateOf("> # a‸"))).toBe("heading1");
    expect(paragraphForm(stateOf("- a‸"))).toBe("paragraph");
    expect(paragraphForm(stateOf("⟨# a\nb⟩"))).toBe("mixed");
    // A blank line is text, which a heading or a list can be put on.
    expect(paragraphForm(stateOf("a\n‸"))).toBe("paragraph");
    // In a code block or the YAML header, no form applies.
    expect(paragraphForm(stateOf("```\na‸\n```"))).toBeNull();
    expect(paragraphForm(stateOf("---\na: b‸\n---\n"))).toBeNull();
  });

  test("read in the text parsed up to the selection's line only", () => {
    // Computed as the caret moves: a long text is not parsed whole.
    const long = `**a‸** b\n\n${"Some *text* here.\n\n".repeat(20_000)}`;
    const state = stateOf(long);
    expect(activeConstructs(state).has("bold")).toBe(true);
    expect(syntaxTreeAvailable(state, state.doc.length)).toBe(false);
  });

  test("far in a long text, in a paragraph that goes on after the line", () => {
    const filler = "Some *text* here.\n\n".repeat(20_000);
    const state = stateOf(`${filler}**a‸\nb**\n\n${filler}`);
    // Not parsed there yet: nothing said rather than waited for.
    expect(activeConstructs(state).size).toBe(0);
    // Parsed up to the caret's line, as the editor's parse in the
    // background will have: the paragraph read whole.
    ensureSyntaxTree(
      state,
      state.doc.lineAt(state.selection.main.to).to,
      10_000,
    );
    expect(activeConstructs(state).has("bold")).toBe(true);
  });

  test("over 200 lines or more, nothing said", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, () => "- a").join("\n");
    // Parsed first: the state reads only what is parsed in its 10 ms,
    // which a loaded machine may not reach (seen in npm test).
    const parsed = (text: string) => {
      const state = stateOf(text);
      ensureSyntaxTree(state, state.doc.length, 60_000);
      return state;
    };
    expect(activeConstructs(parsed(`⟨${lines(200)}⟩`)).has("bulletList")).toBe(
      true,
    );
    expect(activeConstructs(stateOf(`⟨${lines(201)}⟩`)).size).toBe(0);
    expect(paragraphForm(stateOf(`⟨${lines(201)}⟩`))).toBe("mixed");
  });
});
