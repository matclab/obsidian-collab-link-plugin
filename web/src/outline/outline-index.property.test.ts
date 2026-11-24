// The outline followed edit by edit is the outline of the text
// (docs/phase-16-plan-du-document.md, decision 4): the incremental parse
// and the reuse of the headings below an edit change nothing.

import { ChangeSet, Text } from "@codemirror/state";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { OutlineIndex } from "./outline-index.js";
import { outlineOfText } from "./outline.js";

// Pieces that open, close or move blocks: headings, underlines, fences,
// quotes, lists, code, tables, a YAML header, formulas.
const PIECES = [
  "a",
  "b c",
  "\n",
  "\n\n",
  "# ",
  "## ",
  "#",
  " ",
  "    ",
  "===",
  "---",
  "```",
  "~~~",
  "> ",
  "- ",
  "1. ",
  "|a|b|\n|-|-|",
  "$$",
  "*",
  "`",
  "<div>",
];

describe("OutlineIndex (properties)", () => {
  test(
    "after any edits, read or not in between, it is the outline of the text",
    () =>
      hegel.test(
        (tc) => {
          const start = tc
            .draw(gs.arrays(gs.sampledFrom(PIECES), { maxSize: 12 }))
            .join("");
          let doc = Text.of(start.split("\n"));
          const log: string[] = [JSON.stringify(start)];
          const index = new OutlineIndex(doc);
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 10 }));
          for (let i = 0; i < steps; i++) {
            // Anywhere, or at a line's start, where a block's marker is
            // made or undone (random positions rarely land there).
            const position = () => {
              if (tc.draw(gs.booleans())) {
                return tc.draw(
                  gs.integers({ minValue: 0, maxValue: doc.length }),
                );
              }
              const line = doc.line(
                tc.draw(gs.integers({ minValue: 1, maxValue: doc.lines })),
              );
              const offset = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
              return Math.min(line.from + offset, line.to);
            };
            const a = position();
            const b = tc.draw(gs.booleans()) ? a : position();
            const insert = tc
              .draw(gs.arrays(gs.sampledFrom(PIECES), { maxSize: 3 }))
              .join("");
            const changes = ChangeSet.of(
              { from: Math.min(a, b), to: Math.max(a, b), insert },
              doc.length,
            );
            doc = changes.apply(doc);
            index.update(changes, doc);
            log.push(JSON.stringify([Math.min(a, b), Math.max(a, b), insert]));
            if (tc.draw(gs.booleans())) {
              const got = JSON.stringify(index.current());
              const want = JSON.stringify(outlineOfText(doc.toString()));
              if (got !== want) {
                throw new Error(
                  `text=${JSON.stringify(doc.toString())}\nindex=${got}\nwhole=${want}\nedits=${log.join(" ")}`,
                );
              }
            }
          }
          const got = JSON.stringify(index.current());
          const want = JSON.stringify(outlineOfText(doc.toString()));
          if (got !== want) {
            throw new Error(
              `text=${JSON.stringify(doc.toString())}\nindex=${got}\nwhole=${want}\nedits=${log.join(" ")}`,
            );
          }
        },
        { testCases: 400 },
      ),
    120_000,
  );
});
