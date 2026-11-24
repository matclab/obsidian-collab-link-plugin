// From a footnote's reference to its text, and back (phase 20): by the
// editor's parser, with the preview's rules for what is a footnote.
import { Text } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { parseWhole } from "../outline/outline.js";
import { footnoteJump } from "./footnote-jump.js";

/** By the editor's own parser (`markdownSyntax()`). */
function jumpOf(text: string, pos: number): number | null {
  const doc = Text.of(text.split("\n"));
  return footnoteJump(parseWhole(doc), doc, pos);
}

describe("footnoteJump", () => {
  const text =
    "Une phrase[^1], une autre[^longue], encore[^1].\n\n[^1]: La première note.\n\n[^longue]: Voir\n";

  test("from a reference, the start of its definition's text", () => {
    const first = text.indexOf("[^1]");
    for (const at of [first, first + 2, first + 4]) {
      expect(jumpOf(text, at), String(at)).toBe(text.indexOf("La première"));
    }
    expect(jumpOf(text, text.indexOf("encore[^1]") + 8)).toBe(
      text.indexOf("La première"),
    );
    // Its text looks like an address: the parser reads a reference
    // definition.
    expect(jumpOf(text, text.indexOf("longue]") + 1)).toBe(
      text.indexOf("Voir"),
    );
  });

  test("from a definition's label, just after the first reference", () => {
    const definition = text.indexOf("[^1]:");
    for (const at of [definition, definition + 2, definition + 4]) {
      expect(jumpOf(text, at), String(at)).toBe(text.indexOf("[^1]") + 4);
    }
    expect(jumpOf(text, text.indexOf("[^longue]:") + 3)).toBe(
      text.indexOf("[^longue]") + 9,
    );
  });

  test("in a quote or a list, as the preview reads them", () => {
    const quoted = "a[^n]\n\n> [^n]: x y.\n";
    expect(jumpOf(quoted, 2)).toBe(quoted.indexOf("x y"));
    expect(jumpOf(quoted, quoted.indexOf("[^n]:") + 1)).toBe(5);
    const listed = "a[^z]\n\n- [^z]:   b c.\n";
    expect(jumpOf(listed, 2)).toBe(listed.indexOf("b c"));
    expect(jumpOf("> q[^1]\n> [^1]: x\n", 4)).toBe(16);
    // Four spaces continue the paragraph (found by the property).
    expect(jumpOf("q[^1]\n    [^1]: x\n", 2)).toBeNull();
    expect(jumpOf("q[^1]\n   [^1]: x\n", 2)).toBe(15);
    expect(jumpOf("q[^1]\n    [^2]: [^1]: x\n", 2)).toBeNull();
    expect(jumpOf("- q[^1]\n[^1]: x\n", 4)).toBe(14);
  });

  test("nowhere for what the preview does not take as a footnote", () => {
    for (const [source, at] of [
      ["Sans note[^2].\n", "2]"],
      ["Une note en ligne^[écrite à sa place].\n", "écrite"],
      ["Un lien [^1](https://x.org).\n\n[^1]: n\n", "1]("],
      ["Une espace[^a b].\n\n[^a b]: n\n", "a b]."],
      ["Du `code[^1]`.\n\n[^1]: n\n", "1]`"],
      ["Pas un renvoi.\n\n[^1]: n\n", "Pas"],
      ["[^1]: Personne n'y renvoie.\n", "1]"],
    ] as const) {
      expect(jumpOf(source, source.indexOf(at)), source).toBeNull();
    }
  });

  test("a label followed by a colon inside a line is a reference", () => {
    const source = "Au milieu[^1]: a.\n\n[^1]: n\n";
    expect(jumpOf(source, source.indexOf("1]:"))).toBe(source.lastIndexOf("n"));
  });

  test("a reference in a text the parser reads as a link's address or title (found by the property)", () => {
    const source = '[^1]: [^1]\n\n[^a]: <u> "[^a]"\n';
    expect(jumpOf(source, 7)).toBe(6);
    expect(jumpOf(source, 1)).toBe(10);
    expect(jumpOf(source, source.lastIndexOf("[^a]") + 1)).toBe(
      source.indexOf("<u>"),
    );
    // Code (found by the property).
    expect(jumpOf("[^1]: `[^1]`\n\n[^1]\n", 8)).toBeNull();
    // Nor does an escaped one open any.
    expect(jumpOf("[^1]: \\`[^1]`\n\n[^1]\n", 9)).toBe(6);
    // An escaped backslash escapes nothing else.
    expect(jumpOf("[^1]: \\\\[^1]\n\n[^1]\n", 9)).toBe(6);
    // Two backticks are not closed by one.
    expect(jumpOf("[^1]: ``[^1]`\n\n[^1]\n", 9)).toBe(6);
    // After a link's definition left without its address.
    expect(jumpOf("[a b]:\n[^1]: x\n\n[^1]\n", 17)).toBe(13);
    expect(jumpOf("[a b]:\n[^1]:\n\n[^1]\n", 15)).toBe(12);
    expect(jumpOf("[a b]:\n[^1]:\n\n[^1]\n", 8)).toBe(18);
    expect(jumpOf("[a]: <[^1]>\n\n[^1]\n", 15)).toBeNull();
    // A link to a note, for the preview.
    expect(jumpOf("[^1]: [[^1]]\n\n[^1]\n", 8)).toBeNull();
  });

  test("a reference link's text and its label are two references for the preview (found by the property)", () => {
    const source = "a[^1][^2] b[^1][^a b]\n\n[^1]: un\n\n[^2]: deux\n";
    expect(jumpOf(source, 2)).toBe(source.indexOf("un"));
    expect(jumpOf(source, 6)).toBe(source.indexOf("deux"));
    expect(jumpOf(source, source.indexOf("b[^1]") + 2)).toBe(
      source.indexOf("un"),
    );
    expect(jumpOf(source, source.indexOf("a b]"))).toBeNull();
    const linked = "a[^1][^1](u)\n\n[^1]: un\n";
    expect(jumpOf(linked, 6)).toBeNull();
  });

  test("a definition at the start of another's text is one, as the preview reads it in blocks (found by the property)", () => {
    const source = "a[^2]\n\n[^1]: [^2]: deux\n";
    expect(jumpOf(source, 2)).toBe(source.indexOf("deux"));
  });

  test("the last definition when two have the same label: the one the preview shows (found by the property)", () => {
    const source = "a[^1]\n\n[^1]: un\n\n[^1]: deux\n";
    expect(jumpOf(source, 2)).toBe(source.indexOf("deux"));
    expect(jumpOf(source, source.indexOf("[^1]: un") + 1)).toBe(5);
  });

  test("a label's case counts, as in the preview", () => {
    const source = "a[^A]\n\n[^a]: n\n";
    expect(jumpOf(source, 2)).toBeNull();
  });

  test("on the definition's text, nothing: it is written there", () => {
    expect(jumpOf(text, text.indexOf("première"))).toBeNull();
  });
});
