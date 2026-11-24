import { describe, expect, test } from "vitest";
import { calloutHeader, defaultCalloutTitle } from "./callout.js";

// The rule surveyed in Obsidian 1.13.7's reading mode (phase 15, *Relevé
// 15a*): a quote's first line, as written, after its `>`.
describe("calloutHeader", () => {
  test("a type, a fold sign, a title", () => {
    expect(calloutHeader("> [!warning]- Titre *beau*")).toEqual({
      type: "warning",
      family: "warning",
      fold: "-",
      title: "Titre *beau*",
      at: 2,
    });
    expect(calloutHeader("> [!tip]+")).toMatchObject({
      type: "tip",
      fold: "+",
      title: "",
    });
    expect(calloutHeader("> [!note]")).toMatchObject({ fold: "", title: "" });
  });

  test("at most one space after the `>`, up to three before it", () => {
    expect(calloutHeader(">[!note] x")).toMatchObject({ type: "note", at: 1 });
    expect(calloutHeader("   > [!note] x")).toMatchObject({ at: 5 });
    expect(calloutHeader("> > [!tip] x")).toMatchObject({ at: 4 });
    expect(calloutHeader(">  [!note] x")).toBeNull();
    expect(calloutHeader(">\t[!note] x")).toBeNull();
  });

  test("the header is read where the paragraph starts, not at the first `[`", () => {
    expect(calloutHeader("[^1]: > [!note] x", 8)).toMatchObject({ at: 8 });
    expect(calloutHeader("  > [!note] x", 4)).toMatchObject({ at: 4 });
    expect(calloutHeader(">  [!note] x", 4)).toBeNull();
  });

  test("the type: anything but `]`, trimmed, lowercased, spaces as dashes", () => {
    expect(calloutHeader("> [!NOTE]")?.type).toBe("note");
    expect(calloutHeader("> [! note ]")?.type).toBe("note");
    expect(calloutHeader("> [!Mon Type]")?.type).toBe("mon-type");
    expect(calloutHeader("> [!a_b]")?.type).toBe("a_b");
    expect(calloutHeader("> [!Été]")?.type).toBe("été");
    expect(calloutHeader('> [!"><x]')?.type).toBe('"><x');
    expect(calloutHeader("> [!note|meta]")?.type).toBe("note");
    for (const line of [
      "> [!]",
      "> [! ]",
      "> [!a]b]",
      "> [ !note]",
      "> [!|m]",
    ]) {
      expect(calloutHeader(line)).toBeNull();
    }
  });

  test("after the `]`: a sign stuck to it, then a space or the end", () => {
    for (const line of ["> [!tip]-Collé", "> [!info]x", "> [!tip]++"]) {
      expect(calloutHeader(line)).toBeNull();
    }
    expect(calloutHeader("> [!tip] - x")).toMatchObject({
      fold: "",
      title: "- x",
    });
    expect(calloutHeader("> [!tip]-   ")).toMatchObject({
      fold: "-",
      title: "",
    });
  });

  test("not a callout: escaped, in code, emphasized, without a quote", () => {
    for (const line of [
      "> \\[!note]",
      "> `[!note]`",
      "> **[!note]**",
      "[!note] x",
      "- [!note] x",
    ]) {
      expect(calloutHeader(line)).toBeNull();
    }
  });

  test("aliases take their family; an unknown type, note's", () => {
    const family = (type: string) => calloutHeader(`> [!${type}]`)?.family;
    expect(family("summary")).toBe("abstract");
    expect(family("TLDR")).toBe("abstract");
    expect(family("hint")).toBe("tip");
    expect(family("important")).toBe("tip");
    expect(family("done")).toBe("success");
    expect(family("faq")).toBe("question");
    expect(family("caution")).toBe("warning");
    expect(family("missing")).toBe("failure");
    expect(family("error")).toBe("danger");
    expect(family("cite")).toBe("quote");
    expect(family("bug")).toBe("bug");
    expect(family("todo")).toBe("todo");
    expect(family("info")).toBe("info");
    expect(family("example")).toBe("example");
    expect(family("foo-bar")).toBe("note");
    expect(family("constructor")).toBe("note");
  });

  test("the default title: the type, dashes as spaces, a capital first letter", () => {
    expect(defaultCalloutTitle("note")).toBe("Note");
    expect(defaultCalloutTitle("foo-bar")).toBe("Foo bar");
    expect(defaultCalloutTitle("mon-type")).toBe("Mon type");
    expect(defaultCalloutTitle("a_b")).toBe("A_b");
    expect(defaultCalloutTitle("été")).toBe("Été");
  });
});
