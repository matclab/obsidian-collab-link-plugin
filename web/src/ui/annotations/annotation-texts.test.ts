import { beforeEach, describe, expect, test } from "vitest";
import { counter, resetCounters } from "../../perf/index.js";
import { AnnotationTexts } from "./annotation-texts.js";

const card = (body?: string, note?: string, replies: string[] = []) => ({
  body,
  note,
  replies: replies.map((text) => ({ body: text })),
});

describe("AnnotationTexts", () => {
  beforeEach(resetCounters);

  test("renders a text as HTML, its last line break dropped", () => {
    const texts = new AnnotationTexts();
    expect(texts.html("**a**\n\nb")).toBe(
      "<p><strong>a</strong></p>\n<p>b</p>",
    );
    expect(counter("annotation.text.render")).toBe(1);
  });

  // ADR-0047 §9: once while it is shown, whichever card shows it.
  test("renders a text once while a card shows it", () => {
    const texts = new AnnotationTexts();
    texts.keep([card("a", "b", ["c"])]);
    for (const text of ["a", "b", "c", "a", "b", "c"]) texts.html(text);
    texts.keep([card(undefined, "b"), card("a", undefined, ["c", "d"])]);
    for (const text of ["a", "b", "c", "d"]) texts.html(text);
    expect(counter("annotation.text.render")).toBe(4);
  });

  test("forgets a text no card shows any more", () => {
    const texts = new AnnotationTexts();
    texts.keep([card("a")]);
    texts.html("a");
    texts.keep([card("b")]);
    texts.keep([card("a")]);
    texts.html("a");
    expect(counter("annotation.text.render")).toBe(2);
    expect(texts.size).toBe(1);
  });
});
