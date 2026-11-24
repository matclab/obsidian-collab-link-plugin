import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
// @vitest-environment jsdom
// The outline's column under a controlled order (AGENTS.md §1.6;
// docs/phase-16-plan-du-document.md, analysis 16.0, interleavings 1 to 3):
// edits of the text (the others', or this editor's), the outline's
// notification (a microtask), the frame that marks the heading read, a
// heading chosen in a list that may be out of date, the column opened and
// closed, the mode changed, the view closed — each a choice drawn by
// Hegel.
//
// At every step: once the notification has run, the list shown is the
// text's; a heading chosen is reached when the text still has it — the
// caret on it — and nothing moves otherwise; closed, the outline parses
// nothing; closed for good, nothing happens and nothing throws.
import { LoroDoc } from "loro-crdt";
import { afterAll, beforeAll, describe, test } from "vitest";
import { createDocumentEditor } from "../../editor/editor.js";
import { followEditor } from "../../outline/follow-editor.js";
import { OutlineIndex } from "../../outline/outline-index.js";
import { outlineOfText } from "../../outline/outline.js";
import { counter } from "../../perf/index.js";
import type { Mode } from "../reading/view-switch.js";
import { createOutlineColumn } from "./outline-column.js";

const PIECES = ["# A\n", "## B\n", "## A\n", "text\n", "\n", "x", "#", " "];

const saved = {
  scrollIntoView: HTMLElement.prototype.scrollIntoView,
  rangeRects: Range.prototype.getClientRects,
  rangeBox: Range.prototype.getBoundingClientRect,
};
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = saved.scrollIntoView;
  Range.prototype.getClientRects = saved.rangeRects;
  Range.prototype.getBoundingClientRect = saved.rangeBox;
});

describe("the outline's column (controlled order)", () => {
  test(
    "the list shown is the text's once told; a heading chosen is reached if it is still there",
    () =>
      hegel.test(
        (tc) => {
          const contentDoc = new LoroDoc();
          contentDoc
            .getText("content")
            .insert(
              0,
              tc
                .draw(gs.arrays(gs.sampledFrom(PIECES), { maxSize: 8 }))
                .join(""),
            );
          contentDoc.commit();
          const workspace = document.createElement("main");
          const aside = document.createElement("aside");
          const editorParent = document.createElement("div");
          const bar = document.createElement("div");
          const previewRoot = document.createElement("div");
          editorParent.append(bar, previewRoot);
          workspace.append(aside, editorParent);
          document.body.append(workspace);
          const editor = createDocumentEditor(editorParent, contentDoc, {});
          const { view } = editor;
          const notifications: (() => void)[] = [];
          const frames: (() => void)[] = [];
          const index = new OutlineIndex(view.state.doc, (run) =>
            notifications.push(run),
          );
          followEditor(view, index);
          let mode: Mode = "write";
          const modeListeners: ((mode: Mode) => void)[] = [];
          const column = createOutlineColumn(aside, {
            index,
            surfaces: {
              view,
              previewRoot,
              ownColumn: () => false,
              readingTop: () => 0,
            },
            views: {
              mode: () => mode,
              onMode: (listener) => modeListeners.push(listener),
              bar,
            },
            workspace,
            wide: { matches: () => true, onChange: () => {} },
            frame: (run) => frames.push(run),
            topLine: () => 0,
          });
          let closed = false;
          const items = () =>
            Array.from(
              aside.querySelectorAll<HTMLButtonElement>(".outline-item"),
            );
          const toggle = () =>
            bar.querySelector<HTMLButtonElement>(".outline-toggle");
          try {
            const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 24 }));
            for (let step = 0; step < steps; step++) {
              const doc = view.state.doc;
              const action = tc.draw(
                gs.sampledFrom([
                  "edit",
                  "edit",
                  "notify",
                  "frame",
                  "choose",
                  "choose",
                  "toggle",
                  "mode",
                  "close",
                ]),
              );
              const parsesBefore = counter("outline.parse");
              const shown = !aside.hidden && !closed;
              switch (action) {
                case "edit": {
                  const a = tc.draw(
                    gs.integers({ minValue: 0, maxValue: doc.length }),
                  );
                  const b = tc.draw(
                    gs.integers({ minValue: 0, maxValue: doc.length }),
                  );
                  const insert = tc.draw(gs.sampledFrom(["", ...PIECES]));
                  view.dispatch({
                    changes: {
                      from: Math.min(a, b),
                      to: Math.max(a, b),
                      insert,
                    },
                  });
                  break;
                }
                case "notify":
                  for (const run of notifications.splice(0)) run();
                  break;
                case "frame":
                  for (const run of frames.splice(0)) run();
                  break;
                case "choose": {
                  const shownItems = items();
                  if (shownItems.length === 0) break;
                  const chosen = shownItems[
                    tc.draw(
                      gs.integers({
                        minValue: 0,
                        maxValue: shownItems.length - 1,
                      }),
                    )
                  ] as HTMLButtonElement;
                  const text = chosen.textContent?.trim() ?? "";
                  const level = Number(
                    chosen.style.getPropertyValue("--level"),
                  );
                  const before = view.state.selection.main.head;
                  chosen.click();
                  const now = outlineOfText(view.state.doc.toString());
                  const head = view.state.selection.main.head;
                  // A heading of that text is still there: one is reached
                  // (decision 8: same text, else another level of it).
                  const sameText = now.filter((h) => h.text === text);
                  if (
                    sameText.length > 0 &&
                    !sameText.some((h) => h.from === head)
                  ) {
                    throw new Error(
                      `chose ${JSON.stringify(text)} (level ${level}), caret at ${head}, headings ${JSON.stringify(now)}`,
                    );
                  }
                  // None: nothing moves.
                  if (
                    sameText.length === 0 &&
                    head !== before &&
                    !now.some((h) => h.from === head)
                  ) {
                    throw new Error(
                      `chose ${JSON.stringify(text)}, gone, yet the caret moved to ${head}`,
                    );
                  }
                  break;
                }
                case "toggle":
                  toggle()?.click();
                  break;
                case "mode": {
                  mode = tc.draw(
                    gs.sampledFrom(["write", "review", "history"] as Mode[]),
                  );
                  for (const listener of modeListeners) listener(mode);
                  break;
                }
                case "close":
                  if (!closed) {
                    column.destroy();
                    closed = true;
                  }
                  break;
              }
              // Closed (or hidden), the text's edits parse nothing.
              if (!shown && aside.hidden && action === "edit") {
                for (const run of notifications.splice(0)) run();
                if (counter("outline.parse") !== parsesBefore) {
                  throw new Error("the outline parsed while nobody shows it");
                }
              }
              // Told: the list shown is the text's.
              if (!closed && !aside.hidden && notifications.length === 0) {
                const want = outlineOfText(view.state.doc.toString())
                  .filter((h) => h.text)
                  .map((h) => h.text);
                const got = items().map((item) => item.textContent?.trim());
                if (JSON.stringify(got) !== JSON.stringify(want)) {
                  throw new Error(
                    `shown ${JSON.stringify(got)}, text's ${JSON.stringify(want)}, text=${JSON.stringify(view.state.doc.toString())}`,
                  );
                }
              }
              if (closed && aside.querySelector("nav")) {
                throw new Error("the column stayed once the view closed");
              }
            }
          } finally {
            if (!closed) column.destroy();
            view.destroy();
            workspace.remove();
          }
        },
        { testCases: 300 },
      ),
    120_000,
  );
});
