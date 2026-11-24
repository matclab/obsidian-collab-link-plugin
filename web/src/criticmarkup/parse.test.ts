import { describe, expect, test } from "vitest";
import { type ResolvedAnnotation, formatCriticMarkup } from "./format.js";
import { parseCriticMarkup } from "./parse.js";

describe("parseCriticMarkup", () => {
  test("parses an addition as a point in the clean text, its text proposed (ADR-0018)", () => {
    const result = parseCriticMarkup("hello {++world++}");
    expect(result.text).toBe("hello ");
    expect(result.annotations).toEqual([
      { type: "addition", start: 6, end: 6, proposed: "world", status: "open" },
    ]);
    expect(result.notices).toEqual([]);
  });

  test("parses a deletion marker", () => {
    const result = parseCriticMarkup("{--hello--} world");
    expect(result.text).toBe("hello world");
    expect(result.annotations).toEqual([
      { type: "deletion", start: 0, end: 5, status: "open" },
    ]);
  });

  test("parses a substitution: its old text in the clean text, its replacement proposed", () => {
    const result = parseCriticMarkup("{~~hello~>goodbye~~} world");
    expect(result.text).toBe("hello world");
    expect(result.annotations).toEqual([
      {
        type: "substitution",
        start: 0,
        end: 5,
        proposed: "goodbye",
        status: "open",
      },
    ]);
  });

  test("parses a standalone comment marker as a zero-width annotation, body excluded from clean text", () => {
    const result = parseCriticMarkup("hello{>>needs work<<} world");
    expect(result.text).toBe("hello world");
    expect(result.annotations).toEqual([
      {
        type: "comment",
        start: 5,
        end: 5,
        body: "needs work",
        status: "open",
      },
    ]);
  });

  test("moves a comment nested inside an addition to its insertion point, and says so", () => {
    const result = parseCriticMarkup("ab{++hello world{>>nice<<}++}");
    expect(result.text).toBe("ab");
    expect(result.annotations).toEqual([
      {
        type: "addition",
        start: 2,
        end: 2,
        proposed: "hello world",
        status: "open",
      },
      { type: "comment", start: 2, end: 2, body: "nice", status: "open" },
    ]);
    expect(result.notices).toEqual([{ kind: "moved", type: "comment", at: 2 }]);
  });

  test("drops any other annotation nested inside an addition, keeping the text it covered, and says so", () => {
    const result = parseCriticMarkup("{++a{--b--}c++}");
    expect(result.annotations).toEqual([
      { type: "addition", start: 0, end: 0, proposed: "abc", status: "open" },
    ]);
    expect(result.notices).toEqual([
      { kind: "dropped", type: "deletion", at: 0 },
    ]);
  });

  test("reports a notice from inside a deletion at its place in the clean text", () => {
    const result = parseCriticMarkup("xy{--ab{++c{>>n<<}++}--}");
    expect(result.notices).toEqual([{ kind: "moved", type: "comment", at: 4 }]);
  });

  test("a comment right after a suggestion is its note", () => {
    const result = parseCriticMarkup(
      "{--a--}{>>why<<} {++b++}{>>more<<}{>>standalone<<} {~~c~>d~~}{>>so<<}",
    );
    expect(result.text).toBe("a  c");
    expect(result.annotations).toEqual([
      { type: "deletion", start: 0, end: 1, status: "open", note: "why" },
      {
        type: "addition",
        start: 2,
        end: 2,
        proposed: "b",
        status: "open",
        note: "more",
      },
      {
        type: "comment",
        start: 2,
        end: 2,
        body: "standalone",
        status: "open",
      },
      {
        type: "substitution",
        start: 3,
        end: 4,
        proposed: "d",
        status: "open",
        note: "so",
      },
    ]);
  });

  test("a comment after text, or after a comment, stays a comment", () => {
    const result = parseCriticMarkup("{++b++} {>>x<<}");
    expect(result.annotations.map((a) => a.type)).toEqual([
      "addition",
      "comment",
    ]);
  });

  test("throws on an unterminated marker rather than silently mis-scanning", () => {
    expect(() => parseCriticMarkup("{++hello")).toThrow();
  });

  // ADR-0003's interoperability goal: real CriticMarkup written by hand or
  // by another tool, not produced by our own formatCriticMarkup.
  test("imports a hand-written CriticMarkup excerpt without error", () => {
    const result = parseCriticMarkup(
      "The quick {--brown--}{++red++} fox jumps over the lazy dog.{>>double-checked with the style guide<<}",
    );
    expect(result.text).toBe("The quick brown fox jumps over the lazy dog.");
    expect(result.annotations).toHaveLength(3);
  });

  // ADR-0012: strictly nested annotations of different types round-trip
  // through *our own* parser exactly — no guarantee is made (or tested
  // here) that a third-party CriticMarkup reader would handle the nesting,
  // only that formatCriticMarkup → parseCriticMarkup is lossless for it.
  test("two strictly nested annotations of different types round-trip through our own format/parse pair", () => {
    const annotations: ResolvedAnnotation[] = [
      {
        id: "outer",
        type: "deletion",
        author: "alice",
        status: "open",
        createdAt: 0,
        replies: [],
        range: { start: 0, end: 11 },
      },
      {
        id: "inner",
        type: "substitution",
        author: "bob",
        status: "open",
        createdAt: 0,
        replies: [],
        range: { start: 2, end: 5 },
        proposed: "ELL",
      },
    ];
    const formatted = formatCriticMarkup("hello world", annotations);
    const result = parseCriticMarkup(formatted);

    expect(result.text).toBe("hello world");
    expect(result.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "deletion", start: 0, end: 11 }),
        expect.objectContaining({
          type: "substitution",
          start: 2,
          end: 5,
          proposed: "ELL",
        }),
      ]),
    );
  });
});
