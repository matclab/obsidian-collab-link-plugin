// @vitest-environment jsdom
// A change at several places in one transaction (a "replace all", Vim's
// `:%s`, a multi-cursor typing) reaches Loro whole, and the others' edits
// made meanwhile too: the editor's changes are applied to Loro back to
// front (`applyEditorChangesToLoroText`), every offset still the one before
// the transaction.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { createDocumentEditor } from "./editor.js";

// Few letters: the searched text is also found where it was not put, side
// by side, across a line.
const ALPHABET = "ab \n";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

describe("a change at several places in one transaction (property)", () => {
  test(
    "reaches Loro whole, converges with another's concurrent edit",
    () =>
      hegel.test((tc) => {
        const searched = tc.draw(
          gs.text({ minSize: 1, maxSize: 2, alphabet: ALPHABET }),
        );
        const replacement = tc.draw(
          gs.text({ minSize: 0, maxSize: 3, alphabet: "abxy\n" }),
        );
        // The searched text put several times, between others: a text drawn
        // at random would hold it twice in a few cases out of a hundred.
        const pieces = tc.draw(
          gs.arrays(
            gs.oneOf(
              gs.just(searched),
              gs.text({ minSize: 0, maxSize: 4, alphabet: ALPHABET }),
            ),
            { minSize: 2, maxSize: 10 },
          ),
        );
        const base = pieces.join("");

        const docA = new LoroDoc();
        const docB = new LoroDoc();
        const a = createDocumentEditor(document.createElement("div"), docA);
        const b = createDocumentEditor(document.createElement("div"), docB);
        a.view.dispatch({ changes: { from: 0, insert: base } });
        docB.import(docA.export({ mode: "update" }));

        // Another's edit, made before the replace reaches it.
        const length = b.view.state.doc.length;
        const from = tc.draw(gs.integers({ minValue: 0, maxValue: length }));
        const to = tc.draw(gs.integers({ minValue: from, maxValue: length }));
        const inserted = tc.draw(
          gs.text({ minSize: 0, maxSize: 4, alphabet: "abz" }),
        );
        b.view.dispatch({ changes: { from, to, insert: inserted } });

        // The replace, as CodeMirror's search does it: one transaction, a
        // change at each occurrence (`replaceAll`, `@codemirror/search`).
        const changes = [];
        for (
          let at = base.indexOf(searched);
          at >= 0;
          at = base.indexOf(searched, at + searched.length)
        ) {
          changes.push({
            from: at,
            to: at + searched.length,
            insert: replacement,
          });
        }
        const before = docA.oplogVersion();
        a.view.dispatch({ changes });

        const expected = base.split(searched).join(replacement);
        check(
          a.view.state.doc.toString() === expected,
          `editor: ${JSON.stringify(a.view.state.doc.toString())} ≠ ${JSON.stringify(expected)}`,
        );
        check(
          docA.getText("content").toString() === expected,
          `Loro: ${JSON.stringify(docA.getText("content").toString())} ≠ ${JSON.stringify(expected)}`,
        );

        // Diffusion: what A sends since the replace, and B's edit to A.
        docB.import(docA.export({ mode: "update", from: before }));
        docA.import(docB.export({ mode: "update" }));
        const textA = docA.getText("content").toString();
        check(textA === docB.getText("content").toString(), "the docs diverge");
        check(a.view.state.doc.toString() === textA, "A's editor ≠ its doc");
        check(b.view.state.doc.toString() === textA, "B's editor ≠ its doc");
      }),
    20_000,
  );
});
