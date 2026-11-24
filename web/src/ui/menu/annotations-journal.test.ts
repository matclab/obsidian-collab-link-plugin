import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import MarkdownIt from "markdown-it";
import { describe, expect, test } from "vitest";
import { type JournalEntry, journalMarkdown } from "./annotations-journal.js";

/** The journal of the annotations (ADR-0052 §5, JA1 to JA4). */

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  author: "Mathieu",
  verb: "commented",
  when: "11/8/26, 4:46 PM",
  state: "open",
  replies: [],
  ...over,
});

/** The blocks at the top of the document, and the text of every
 * blockquote. */
function read(markdown: string) {
  const tokens = new MarkdownIt("commonmark").parse(markdown, {});
  const top = tokens.filter((token) => token.level === 0);
  return {
    h1: top.filter(
      (token) => token.type === "heading_open" && token.tag === "h1",
    ).length,
    h2: tokens.filter(
      (token) =>
        token.type === "heading_open" &&
        token.tag === "h2" &&
        token.level === 0,
    ).length,
    /** What a block outside every quote may be: only the journal's own
     * (its headings, labels, field and reply lists). */
    outside: (() => {
      let depth = 0;
      const types = new Set<string>();
      for (const token of tokens) {
        if (token.type === "blockquote_open") depth++;
        else if (token.type === "blockquote_close") depth--;
        else if (depth === 0 && token.nesting !== -1 && token.block) {
          types.add(
            token.type === "heading_open"
              ? `${token.type}:${token.tag}`
              : token.type,
          );
        }
      }
      return [...types].sort();
    })(),
    headings: tokens
      .map((token, i) =>
        token.type === "heading_open" && token.level === 0
          ? tokens[i + 1]?.children?.map((child) => child.content).join("")
          : undefined,
      )
      .filter((text) => text !== undefined),
  };
}

describe("journalMarkdown", () => {
  test("a title, then each annotation under its heading: who, what, when, its state, its texts, its thread", () => {
    const markdown = journalMarkdown("Compte rendu", [
      entry({
        state: "resolved, by Carol",
        annotated: { text: "police", how: "deleted 11/8/26 by Bob" },
        body: "Which one?",
        replies: [
          { author: "Carol", when: "11/8/26, 5:00 PM", body: "Serif." },
        ],
      }),
      entry({
        verb: "suggests replacing",
        state: "rejected",
        annotated: { text: "week" },
        proposal: "two weeks",
        note: "Too short.",
      }),
      entry({ verb: "suggests deleting", annotated: "unavailable" }),
    ]);

    expect(read(markdown).headings).toEqual([
      "Compte rendu — annotations",
      "1. Mathieu commented",
      "2. Mathieu suggests replacing",
      "3. Mathieu suggests deleting",
    ]);
    expect(markdown).toContain("- State: resolved, by Carol");
    expect(markdown).toContain(
      "Annotated text, deleted 11/8/26 by Bob:\n\n> police",
    );
    expect(markdown).toContain("Comment:\n\n> Which one?");
    expect(markdown).toContain("Proposed text:\n\n> two weeks");
    expect(markdown).toContain("Note:\n\n> Too short.");
    expect(markdown).toContain("- Carol, 11/8/26, 5:00 PM:\n\n  > Serif.");
    expect(markdown).toContain("Annotated text: earlier text unavailable");
  });

  test("JA3: a heading, a list or a rule written in a text stays in its quote", () => {
    const markdown = journalMarkdown("T", [
      entry({ body: "# Not a heading\n\n- not a list\n\n---\n## nor this" }),
      entry({
        replies: [{ author: "B", when: "now", body: "# nor\n\n## this" }],
      }),
    ]);
    const { h1, h2 } = read(markdown);
    expect(h1).toBe(1);
    expect(h2).toBe(2);
  });

  test("a name can't break its heading", () => {
    const markdown = journalMarkdown("T", [entry({ author: "a\n# b *c*" })]);
    expect(read(markdown).headings).toEqual([
      "T — annotations",
      "1. a # b *c* commented",
    ]);
  });

  // Found by the property, 2026-11-08: a reply's author at the head of
  // its list item, « 1. l », opened an ordered list out of every quote.
  test("a name with a list's marker, at the head of a reply, opens no list", () => {
    const markdown = journalMarkdown("T", [
      entry({
        replies: [
          { author: " 1. l", when: "now", body: "a" },
          { author: "- m", when: "now", body: "b" },
        ],
      }),
    ]);
    expect(read(markdown).outside).not.toContain("ordered_list_open");
    expect(markdown).toContain("- 1\\. l, now:");
  });

  test("no annotation: says so", () => {
    expect(journalMarkdown("T", [])).toContain("No annotation.");
  });
});

const TEXTS = [
  "a",
  "# h",
  "## h",
  "- l",
  "1. l",
  "---",
  "> q",
  "```",
  "",
  "    code",
  "*e*",
  "<b>",
  "[x]: u",
  "===",
  "\\",
];

describe("journalMarkdown, property", () => {
  test("JA1, JA3: each annotation once, under its own heading; nothing written by someone out of its quote", () =>
    hegel.test(
      (tc) => {
        const text = () =>
          tc
            .draw(gs.arrays(gs.sampledFrom(TEXTS), { maxSize: 4 }))
            .join(tc.draw(gs.sampledFrom(["\n", "\n\n", " "])));
        const maybe = () => (tc.draw(gs.booleans()) ? text() : undefined);
        const entries = tc.draw(gs.arrays(gs.just(0), { maxSize: 5 })).map(() =>
          entry({
            author: text(),
            body: maybe(),
            note: maybe(),
            proposal: maybe(),
            annotated: tc.draw(gs.booleans())
              ? { text: text() }
              : "unavailable",
            replies: tc
              .draw(gs.arrays(gs.just(0), { maxSize: 2 }))
              .map(() => ({ author: text(), when: "now", body: text() })),
          }),
        );
        const { h1, h2, headings, outside } = read(
          journalMarkdown(text(), entries),
        );
        for (const type of outside) {
          expect([
            "bullet_list_open",
            "heading_open:h1",
            "heading_open:h2",
            "inline",
            "list_item_open",
            "paragraph_open",
          ]).toContain(type);
        }
        expect(h1).toBe(1);
        expect(h2).toBe(entries.length);
        expect(
          headings.slice(1).map((heading) => heading.split(".")[0]),
        ).toEqual(entries.map((_, i) => String(i + 1)));
      },
      { testCases: 300 },
    ));
});
