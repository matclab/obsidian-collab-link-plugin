// The exported file's header (docs/phase-14-plugin-obsidian.md, decision
// 3): `content` as it is, with two properties of the file's own,
// `collab-document` and `collab-version`; added to `content`'s own YAML
// header if it has one, taken out again before any comparison — whatever
// `content` is, it comes back exact.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  type NoteHeader,
  formatVersion,
  parseVersion,
  readHeader,
  readLooseHeader,
  writeHeader,
} from "./note-header.js";

const EOL = gs.sampledFrom(["\n", "\r\n"]);

/** A line of a note: text, YAML, and what looks like a header's. */
const line = gs.oneOf(
  gs.text({ maxSize: 12 }).map((text) => text.replace(/[\r\n]/g, "")),
  gs.sampledFrom([
    "---",
    "--- ",
    "...",
    "",
    "tags: [a, b]",
    "title: Note",
    'collab-document: "other"',
    'collab-version: "1@2"',
    "# Title",
  ]),
);

/** A note's text: often starting with a YAML header, closed or not, empty
 * or not. */
const content = gs.composite((tc) => {
  const eol = tc.draw(EOL);
  const lines = (max: number) =>
    tc.draw(gs.arrays(line, { maxSize: max })).join(eol);
  const body = lines(6);
  const start = tc.draw(
    gs.sampledFrom(["none", "header", "empty header", "unclosed"]),
  );
  if (start === "header") return `---${eol}${lines(3)}${eol}---${eol}${body}`;
  if (start === "empty header") return `---${eol}---${eol}${body}`;
  if (start === "unclosed") return `---${eol}${body}`;
  return body;
});

const opId = gs.composite((tc) => ({
  peer: String(
    tc.draw(gs.bigIntegers({ minValue: 0n, maxValue: 2n ** 64n - 1n })),
  ) as `${number}`,
  counter: tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 31 - 1 })),
}));

const header = gs.composite(
  (tc): NoteHeader => ({
    document: tc.draw(gs.fromRegex("[A-Za-z0-9_-]{1,40}", { fullmatch: true })),
    version: formatVersion(tc.draw(gs.arrays(opId, { maxSize: 4 }))),
  }),
);

describe("the exported file's header", () => {
  test("whatever the text, it comes back exact, and the header with it", () => {
    hegel.test(
      (tc) => {
        const text = tc.draw(content);
        const written = tc.draw(header);
        expect(readHeader(writeHeader(text, written))).toEqual({
          content: text,
          header: written,
        });
      },
      { testCases: 500 },
    );
  });

  test("its properties are the first of the file's YAML header: Obsidian shows them, the text's own after", () => {
    const written = { document: "doc", version: "3@12" };
    expect(writeHeader("# Note\n", written)).toBe(
      '---\ncollab-document: "doc"\ncollab-version: "3@12"\n---\n# Note\n',
    );
    expect(writeHeader("---\ntags: [a]\n---\n# Note\n", written)).toBe(
      '---\ncollab-document: "doc"\ncollab-version: "3@12"\ntags: [a]\n---\n# Note\n',
    );
  });

  test("a file without it is all text, with no header", () => {
    for (const file of [
      "",
      "# Note\n",
      "---\ntags: [a]\n---\nx",
      '---\ntags: [a]\ncollab-document: "doc"\ncollab-version: "1@2"\n---\n',
      '---\ncollab-document: "doc"\n---\n',
    ]) {
      expect(readHeader(file)).toEqual({ content: file, header: undefined });
    }
  });
});

/** What another tool may make of the two properties (decision 20): no
 * quotes, single quotes, moved among the others, spaces, CRLF. */
const reformatted = gs.composite((tc) => {
  const written = tc.draw(header);
  const text = tc.draw(content);
  const file = writeHeader(text, written);
  const quote = tc.draw(gs.sampledFrom(['"', "'", ""]));
  const space = tc.draw(gs.sampledFrom([" ", "  ", "\t"]));
  const lines = (name: string, value: string) =>
    `collab-${name}:${space}${quote}${value}${quote}`;
  let changed = file
    .replace(
      `collab-document: "${written.document}"`,
      lines("document", written.document),
    )
    .replace(
      `collab-version: "${written.version}"`,
      lines("version", written.version),
    );
  // Moved past a line of the text's that looks like it: ambiguous, the
  // first one is ours.
  if (!text.includes("collab-version") && tc.draw(gs.booleans())) {
    // The version moved after the document's other properties.
    const ours = lines("version", written.version);
    const at = changed.indexOf(ours);
    const without = changed.slice(0, at) + changed.slice(at + ours.length + 1);
    const close = without.indexOf("\n---", 3);
    changed = `${without.slice(0, close + 1)}${ours}\n${without.slice(close + 1)}`;
  }
  return { text, written, file: changed };
});

describe("the header, read loosely (decision 20)", () => {
  test("gives back the text and the header of what writeHeader wrote", () => {
    hegel.test(
      (tc) => {
        const text = tc.draw(content);
        const written = tc.draw(header);
        expect(readLooseHeader(writeHeader(text, written))).toEqual({
          content: text,
          document: written.document,
          version: written.version,
        });
      },
      { testCases: 500 },
    );
  });

  test("still finds them, and the text, once another tool reformatted them", () => {
    hegel.test(
      (tc) => {
        const { text, written, file } = tc.draw(reformatted);
        expect(readLooseHeader(file)).toEqual({
          content: text,
          document: written.document,
          version: written.version,
        });
      },
      { testCases: 500 },
    );
  });

  test("a file without collab-document is all text", () => {
    for (const file of [
      "",
      "# Note\n",
      "---\ntags: [a]\n---\nx",
      '---\ncollab-version: "1@2"\n---\nx',
      '---\ncollab-document: "doc"\n',
      'x\n---\ncollab-document: "doc"\n---\n',
      "---\ncollab-document:\n---\nx",
      "---\ncollab-document: a b\n---\nx",
    ]) {
      expect(readLooseHeader(file)).toEqual({ content: file });
    }
  });

  test("without a version, the document alone", () => {
    expect(
      readLooseHeader("---\ncollab-document: doc\ntags: [a]\n---\nx"),
    ).toEqual({
      content: "---\ntags: [a]\n---\nx",
      document: "doc",
    });
  });
});

describe("a version", () => {
  test("reads back as the frontiers written, whatever their order", () => {
    hegel.test(
      (tc) => {
        const frontiers = tc.draw(gs.arrays(opId, { maxSize: 5 }));
        const shuffled = [...frontiers].reverse();
        expect(formatVersion(shuffled)).toBe(formatVersion(frontiers));
        const read = parseVersion(formatVersion(frontiers));
        const key = (id: { peer: string; counter: number }) =>
          `${id.peer}@${id.counter}`;
        expect(read?.map(key).sort()).toEqual(frontiers.map(key).sort());
      },
      { testCases: 300 },
    );
  });

  test("anything else is no version", () => {
    for (const text of ["x", "1@", "@2", "1@2 x", "-1@2", "1@2@3", "1.5@2"]) {
      expect(parseVersion(text)).toBeUndefined();
    }
    expect(parseVersion("")).toEqual([]);
  });
});
