// @vitest-environment jsdom
//
// The editor's formulas and the loading of KaTeX (phase 11, decision 10;
// AGENTS.md §1.6; written analysis in docs/phase-11-*.md, 11d.3): every
// source of asynchrony is a choice of the test — edits, focus and caret
// (which show a line's source and take its widgets away), CodeMirror's
// timer, the end of each load, successful or failed, and two of the
// browser's clock (« Défauts connus », 2026-10-21): CodeMirror's
// measures, on an animation frame, and its parse, cut short when its
// budget of time is spent — a partial tree drawn, finished later.

import { forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { KatexModule } from "../view-model/katex.js";
import { createDocumentEditor } from "./editor.js";

// Not faked: the widgets' own work outside the held loads runs in
// microtasks, all done by the next macrotask.
//
// Faked (beforeEach): the timers, the animation frames, and the clock,
// which stands still — a parse only stops short when the test says
// (`cutShort`).
const tick = () => new Promise((resolve) => setImmediate(resolve));

interface Held {
  release: () => void;
  fail: () => void;
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A KaTeX that writes down what it renders: its source and its mode. */
const katex = {
  renderToString: (tex: string, options?: { displayMode?: boolean }) =>
    `<b class="tex" data-tex="${escapeHtml(tex)}" data-display="${options?.displayMode ?? false}"></b>`,
} as KatexModule;

// Each case its own formulas: the renderings cache, shared by the page,
// would otherwise draw them at once, without a load to wait for. Numbered
// on a fixed width: a case replayed later (Hegel checks a slow one again)
// must have the same text, and the same bounds for what it draws.
let cases = 0;

function bodies(n: string): string[] {
  return [
    "Du texte sans formule.",
    // The same source inline and displayed: two renderings.
    `Soit $e_{${n}}$ et $$e_{${n}}$$ ici.`,
    `$$\nf_{${n}}\n$$`,
    `| x | y |\n|---|---|\n| $g_{${n}}$ | $$e_{${n}}$$ |`,
  ];
}

/** Runs `work` on a clock that jumps at each reading: the parse it
 * starts spends its budget at once, as on a loaded machine. */
function cutShort(work: () => void): void {
  const still = Date.now;
  let at = still();
  Date.now = () => {
    at += 1000;
    return at;
  };
  try {
    work();
  } finally {
    Date.now = still;
  }
}

/** The parse finished: every formula's widget made. */
const parseAll = (view: EditorView) =>
  forceParsing(view, view.state.doc.length, 5000);

async function scenario(tc: TestCase): Promise<void> {
  const n = String(++cases).padStart(6, "0");
  const held: Held[] = [];
  const problems: string[] = [];
  let failures = 0;

  const doc = new LoroDoc();
  const parent = document.createElement("div");
  document.body.append(parent);
  const { view } = createDocumentEditor(parent, doc, {
    livePreview: true,
    katex: () =>
      new Promise<KatexModule>((resolve, reject) => {
        held.push({
          release: () => resolve(katex),
          fail: () => {
            failures++;
            reject(new Error("load failed"));
          },
        });
      }),
  });

  // Every formula element ever seen, and what it held once detached.
  const seen = new Map<HTMLElement, string | undefined>();
  const formulas = () =>
    Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>(".cm-live-math, .math"),
    );
  const displayed = (element: HTMLElement) =>
    element.classList.contains("cm-live-math-display") ||
    element.classList.contains("math-display");
  const check = (step: string) => {
    for (const element of formulas()) {
      if (!seen.has(element)) seen.set(element, undefined);
      // Invariant 1: its own source, in its own mode.
      const drawn = element.querySelector<HTMLElement>(".tex");
      if (
        drawn &&
        (drawn.dataset.tex !== element.dataset.tex ||
          drawn.dataset.display !== String(displayed(element)))
      ) {
        problems.push(
          `${step}: ${drawn.dataset.tex} (${drawn.dataset.display}) in ${element.dataset.tex} (${displayed(element)})`,
        );
      }
    }
    // Invariant 2: nothing written into an element gone from the editor.
    for (const [element, held] of seen) {
      if (element.isConnected) continue;
      if (held === undefined) seen.set(element, element.innerHTML);
      else if (element.innerHTML !== held)
        problems.push(`${step}: written into ${element.dataset.tex}, gone`);
    }
  };

  const body = () =>
    tc
      .draw(gs.arrays(gs.sampledFrom(bodies(n)), { minSize: 1, maxSize: 4 }))
      .join("\n\n");
  try {
    view.dispatch({ changes: { from: 0, insert: body() } });
    parseAll(view);
    check("start");
    const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
    for (let i = 0; i < steps && problems.length === 0; i++) {
      let step: string;
      switch (
        tc.draw(
          gs.sampledFrom([
            "edit",
            "caret",
            "blur",
            "timer",
            "frame",
            "parse",
            "end",
          ]),
        )
      ) {
        case "edit": {
          const changes = {
            from: 0,
            to: view.state.doc.length,
            insert: body(),
          };
          // Parsed whole at once, or cut short: the rest is parsed by the
          // step « parse » (or CodeMirror's timer, past its pause).
          if (tc.draw(gs.booleans())) {
            cutShort(() => view.dispatch({ changes }));
            step = "edit, parse cut short";
          } else {
            view.dispatch({ changes });
            step = "edit";
          }
          break;
        }
        case "frame":
          // CodeMirror's measures.
          vi.advanceTimersToNextFrame();
          step = "frame";
          break;
        case "parse":
          parseAll(view);
          step = "parse";
          break;
        case "caret": {
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: view.state.doc.length }),
          );
          view.focus();
          view.dispatch({ selection: { anchor: at } });
          step = `caret ${at}`;
          break;
        }
        case "blur":
          view.contentDOM.blur();
          step = "blur";
          break;
        case "timer":
          // CodeMirror reports a change of focus on a timer.
          vi.advanceTimersByTime(50);
          step = "timer";
          break;
        default: {
          if (held.length === 0) continue;
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: held.length - 1 }),
          );
          const [load] = held.splice(at, 1);
          if (tc.draw(gs.booleans())) {
            load?.release();
            step = "load ends";
          } else {
            load?.fail();
            step = "load fails";
          }
        }
      }
      await tick();
      check(step);
    }

    // Every load let through, the focus gone: every formula drawn.
    view.contentDOM.blur();
    parseAll(view);
    do {
      vi.advanceTimersToNextFrame();
      vi.advanceTimersByTime(50);
      for (const load of held.splice(0)) load.release();
      await tick();
    } while (held.length > 0);
    check("end");
    // Every formula of the text has its element, the parse finished: none
    // left as text by a tree drawn before it was whole. Each holds one
    // `_{n}`, nothing else does.
    const written = view.state.doc.toString().split(`_{${n}}`).length - 1;
    if (formulas().length !== written) {
      problems.push(`end: ${formulas().length} formulas drawn of ${written}`);
    }
    if (failures === 0) {
      // Invariant 3 (with failures, invariant 4: a failed one keeps its
      // source until drawn again).
      for (const element of formulas()) {
        if (!element.querySelector(".tex"))
          problems.push(`end: ${element.dataset.tex} not drawn`);
      }
    }
  } finally {
    view.destroy();
    parent.remove();
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  // A failed load is warned about; here, by design.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the editor's formulas and the loading of KaTeX (property)", () => {
  test(
    "a formula shows only its own rendering, nothing is written into one gone, all are drawn once loaded",
    () => hegel.testAsync(scenario, { testCases: 400 }),
    600_000,
  );
});
