// Where a suggestion at the caret goes (phase 24): at the start of a
// heading, an item or a quote, in a paragraph of its own before the line,
// or at the start of the line's text; never before the line's markup,
// where accepting it would undo the construct.
import { EditorState, Text } from "@codemirror/state";
import { describe, expect, test } from "vitest";
import { markdownSyntax } from "./markdown-syntax.js";
import { additionPlaces, asOwnParagraph } from "./suggestion-place.js";

function state(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: markdownSyntax() });
}

/** `¦` marks the caret. */
function placesAt(marked: string) {
  const at = marked.indexOf("¦");
  return additionPlaces(state(marked.replace("¦", "")), at);
}

describe("additionPlaces", () => {
  test("at the start of a heading: a paragraph of its own before it, preferred, or after its markup", () => {
    expect(placesAt("Para.\n\n¦### Title\n")).toEqual({
      paragraph: 7,
      inline: 11,
      preferred: "paragraph",
    });
    // The caret right before its text, its markup hidden: the same.
    expect(placesAt("Para.\n\n### ¦Title\n")).toEqual({
      paragraph: 7,
      inline: 11,
      preferred: "paragraph",
    });
  });

  test("at the start of an item, a task or a quote, after all of its markup", () => {
    expect(placesAt("¦- item")).toEqual({
      paragraph: 0,
      inline: 2,
      preferred: "paragraph",
    });
    expect(placesAt("¦- [ ] task")).toEqual({
      paragraph: 0,
      inline: 6,
      preferred: "paragraph",
    });
    expect(placesAt("¦> - quoted item")).toEqual({
      paragraph: 0,
      inline: 4,
      preferred: "paragraph",
    });
  });

  test("on a blank line, a paragraph only: in the line, it would join a neighbour", () => {
    expect(placesAt("Para.\n¦\n### Title")).toEqual({
      paragraph: 6,
      preferred: "paragraph",
    });
  });

  test("at the start of a plain paragraph, in the line preferred", () => {
    expect(placesAt("Para.\n\n¦Next one.")).toEqual({
      paragraph: 7,
      inline: 7,
      preferred: "inline",
    });
  });

  test("before a table, a paragraph only; in a table, a code block, a paragraph or mid-line, nothing to choose", () => {
    expect(placesAt("¦| a |\n|---|\n| 1 |")).toEqual({
      paragraph: 0,
      preferred: "paragraph",
    });
    expect(placesAt("| a |\n|---|\n¦| 1 |")).toBeNull();
    expect(placesAt("```\n¦# not a heading\n```")).toBeNull();
    expect(placesAt("### Ti¦tle")).toBeNull();
    // A paragraph's next line: splitting it is not what is meant.
    expect(placesAt("Para *a\n¦b* c")).toBeNull();
  });
});

describe("asOwnParagraph", () => {
  const insert = (text: string, at: number, proposed: string) =>
    text.slice(0, at) +
    asOwnParagraph(Text.of(text.split("\n")), at, proposed) +
    text.slice(at);

  test("set apart by a blank line on each side, no more", () => {
    expect(insert("Para.\n\n### Title", 7, "New")).toBe(
      "Para.\n\nNew\n\n### Title",
    );
    expect(insert("Para.\n### Title", 6, "New")).toBe(
      "Para.\n\nNew\n\n### Title",
    );
    expect(insert("### Title", 0, "New")).toBe("New\n\n### Title");
    // On a blank line, between two others or at the end.
    expect(insert("Para.\n\n### Title", 6, "New")).toBe(
      "Para.\n\nNew\n\n### Title",
    );
    expect(insert("Para.\n\n\n### Title", 7, "New")).toBe(
      "Para.\n\nNew\n\n### Title",
    );
    expect(insert("Para.\n", 6, "New")).toBe("Para.\n\nNew");
  });

  test("the proposed text's own line breaks at its ends are not counted twice", () => {
    expect(insert("Para.\n\n### Title", 7, "\nNew\n\n")).toBe(
      "Para.\n\nNew\n\n### Title",
    );
  });
});
