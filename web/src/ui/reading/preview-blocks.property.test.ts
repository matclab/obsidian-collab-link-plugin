// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { renderMarkdown } from "../../render/index.js";
import { createPreview } from "./preview.js";

// Blocks alike, repeated, reordered: what matching kept blocks can get
// wrong (no formula nor diagram: nothing is filled in).
const BLOCKS = [
  "a",
  "b",
  "c",
  "a",
  "b",
  "c",
  "# t",
  "- x\n- y",
  "> q",
  "| h |\n|---|\n| c |",
  "n[^1]\n\n[^1]: f",
  "```\ncode\n```",
];

/** Each block's HTML, without the source lines the preview puts on it
 * (phase 10e): those are checked by render/blocks.property.test.ts. */
function blocks(root: Element): string[] {
  return Array.from(root.children, (element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    delete copy.dataset.line;
    delete copy.dataset.lineEnd;
    return copy.outerHTML;
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("preview blocks (property)", () => {
  test(
    "after any edits, shows exactly what a fresh rendering of the text shows, never moving a kept block",
    () =>
      hegel.test(
        (tc) => {
          const view = new EditorView({ doc: "" });
          const container = document.createElement("div");
          const preview = createPreview(container, view);
          preview.show();
          const content = container.querySelector(".preview");
          if (!content) throw new Error("no preview");
          // A block moved is detached then put back: its frames would reload.
          const observer = new MutationObserver(() => {});
          observer.observe(content, { childList: true });
          const edits = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
          for (let i = 0; i < edits; i++) {
            const text = tc
              .draw(gs.arrays(gs.sampledFrom(BLOCKS), { maxSize: 6 }))
              .join("\n\n");
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: text },
            });
            vi.runAllTimers();
            for (const record of observer.takeRecords()) {
              for (const node of Array.from(record.removedNodes)) {
                if (node.parentNode === content) {
                  throw new Error(`moved: ${(node as Element).outerHTML}`);
                }
              }
            }
            const fresh = document.createElement("div");
            fresh.innerHTML = renderMarkdown(text);
            const expected = blocks(fresh);
            const shown = blocks(content);
            if (JSON.stringify(shown) !== JSON.stringify(expected)) {
              throw new Error(
                `text=${JSON.stringify(text)}\nshown=${shown.join("")}\nexpected=${expected.join("")}`,
              );
            }
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
