import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { createPeer, syncAll } from "../../lib/src/test-support/peers.js";
import { applyChangesToString, loroDeltaToChangeSpec } from "./binding.js";

// Restricted to the BMP, no surrogate pairs: Loro's default position
// indexing is UTF-16 code units (same as CodeMirror and JS strings), and
// surrogate-pair handling is not what this property is about.
const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-\n";

// Generalizes choice/loro/t5-codemirror6-integration/test-logic.mjs (fixed
// cases) into a generative model-based property: an "observer" peer that only
// ever consumes remote Loro deltas through loroDeltaToChangeSpec +
// applyChangesToString (standing in for EditorView.dispatch) must always end
// up with exactly the text the real LoroDoc converged to.
describe("loro delta -> positional edit round-trip (model-based, generalizes T5 test-logic.mjs)", () => {
  test("an observer applying only converted deltas matches the real converged document", () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(
        gs.text({ minSize: 0, maxSize: 40, alphabet: ALPHABET }),
      );
      const editCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));

      const author = createPeer();
      author.getText("doc").insert(0, base);

      const observer = createPeer();
      syncAll([author, observer]);

      let observerModel = base;
      observer.getText("doc").subscribe((batch) => {
        if (batch.by !== "import") return;
        for (const event of batch.events) {
          if (event.diff.type !== "text") continue;
          const changes = loroDeltaToChangeSpec(event.diff.diff);
          observerModel = applyChangesToString(observerModel, changes);
        }
      });

      const editors = Array.from({ length: editCount }, () => createPeer());
      for (const editor of editors) syncAll([author, editor]);

      for (const editor of editors) {
        const text = editor.getText("doc");
        const len = text.toString().length;
        const op = tc.draw(gs.sampledFrom(["insert", "delete"] as const));
        if (op === "insert" || len === 0) {
          const pos = tc.draw(gs.integers({ minValue: 0, maxValue: len }));
          const inserted = tc.draw(
            gs.text({ minSize: 1, maxSize: 10, alphabet: ALPHABET }),
          );
          text.insert(pos, inserted);
        } else {
          const pos = tc.draw(gs.integers({ minValue: 0, maxValue: len - 1 }));
          const delLen = tc.draw(
            gs.integers({ minValue: 1, maxValue: len - pos }),
          );
          text.delete(pos, delLen);
        }
      }

      syncAll([author, observer, ...editors]);

      const expected = observer.getText("doc").toString();
      if (observerModel !== expected) {
        throw new Error(
          `model diverged from real Loro text: model=${JSON.stringify(observerModel)} real=${JSON.stringify(expected)}`,
        );
      }
    }));
});
