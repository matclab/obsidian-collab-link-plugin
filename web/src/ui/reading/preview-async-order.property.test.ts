// @vitest-environment jsdom
//
// The preview's interleavings (docs/phase-6-*.md, step 4; AGENTS.md §1.6):
// every source of asynchrony is a choice of the test, drawn by Hegel —
// edits, showing and hiding, the regrouping timer, the loading of KaTeX
// and of Pele, the end of each diagram's drawing (its type loaded on first
// use, which may fail once: offline); the reader's grants of remote
// images, one failing to load, the reader's caret, and another's, whose
// presence arrives when drawn (ADR-0055 §12).
import { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import katex from "katex";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { Presence, RemotePresence } from "../../../lib/src/index.js";
import {
  attachRemoteCursors,
  remoteCaretPositions,
} from "../../editor/remote-cursors.js";
import { counter, resetCounters } from "../../perf/index.js";
import { remoteImageSources } from "../../render/index.js";
import { createRemoteImages } from "../../view-model/remote-images.js";
import { RENDER_DELAY_MS, createPreview } from "./preview.js";

// Not faked: the preview's own work outside the held steps runs in
// microtasks, all done by the next macrotask.
const tick = () => new Promise((resolve) => setImmediate(resolve));

interface Held {
  label: string;
  release: () => void;
}

const IMAGES = ["https://img.example/a.png", "https://img.example/b.png"];

const BODIES = [
  "plain",
  "$x$",
  "$$y$$ and $x$",
  "```mermaid\nA\n```",
  "```mermaid\nbad\n```",
  "```mermaid\noff\n```",
  "$x$\n\n```mermaid\nB\n```\n\n```mermaid\nA\n```",
  `![a](${IMAGES[0]})`,
  `![a](${IMAGES[0]})\n\ntext\n\n![b](${IMAGES[1]})`,
  `$x$ ![b](${IMAGES[1]})\n\n![c](https://img.example)`,
  `![r][r]\n\ntext\n\n[r]: ${IMAGES[0]}`,
];

class Refusal extends Error {}

async function scenario(tc: TestCase): Promise<void> {
  const held: Held[] = [];
  const hold = <T>(label: string, value: () => T) =>
    new Promise<T>((resolve, reject) => {
      held.push({
        label,
        release: () => {
          try {
            resolve(value());
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  const problems: string[] = [];
  // `off` fails to load its type the first time only.
  let offline = true;

  const view = new EditorView({ doc: "v0\n\nplain" });
  const container = document.createElement("div");
  const shownVersion = () =>
    Number(container.querySelector("p")?.textContent?.slice(1) ?? -1);
  const sourcesShown = () =>
    Array.from(container.querySelectorAll<HTMLElement>(".mermaid")).map(
      (element) => element.dataset.source,
    );

  // Another's caret, as the presence gives it, arrived when drawn.
  let others: RemotePresence[] = [];
  let shown = 0;
  const presenceListeners = new Set<() => void>();
  const presence = {
    others: () => others,
    // Each notification here changes what is shown (R-P7).
    shown: () => shown,
    subscribe(listener: () => void) {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
  } as unknown as Presence;
  attachRemoteCursors(view, presence, { subscribe: () => () => {} });
  const images = createRemoteImages("doc", undefined);
  let told: readonly string[] = [];
  const preview = createPreview(
    container,
    view,
    {
      katex: () => hold("katex", () => katex),
      diagrams: () =>
        hold("diagrams", () => ({
          render(source: string) {
            // Invariant 2: no work for a rendering no longer shown.
            if (!preview.visible || !sourcesShown().includes(source)) {
              problems.push(`drew ${JSON.stringify(source)}, not shown`);
            }
            return hold(`draw ${source}`, () => {
              if (source.startsWith("bad")) throw new Refusal("Parse error");
              if (source.startsWith("off") && offline) {
                offline = false;
                throw new Error("offline");
              }
              return {
                svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`,
              };
            });
          },
          refuses: (error: unknown) => error instanceof Refusal,
        })),
    },
    images,
  );
  preview.onImages((sources) => {
    told = sources;
  });
  // The carets' lines now, from 0: the reader's, and the other's as the
  // editor shows it — followed through the edits since it arrived.
  const caretLines = () => {
    const { state } = view;
    const at = [state.selection.main.head, ...remoteCaretPositions(state)];
    return at.map((position) => state.doc.lineAt(position).number - 1);
  };
  const everShown = new Set<string>();
  // An image's lines (§12): its block's, and those of a definition of its
  // address, found in the text by the test itself.
  const imageLines = (element: Element, src: string) => {
    const block = element.closest<HTMLElement>("[data-line]");
    const lines: [number, number][] = [
      [Number(block?.dataset.line), Number(block?.dataset.lineEnd)],
    ];
    view.state.doc
      .toString()
      .split("\n")
      .forEach((line, at) => {
        if (/^\[[^\]]*\]:/.test(line) && line.includes(src)) {
          lines.push([at, at + 1]);
        }
      });
    return lines;
  };
  const underCaret = (lines: [number, number][]) =>
    caretLines().some((line) =>
      lines.some(([first, end]) => first <= line && line < end),
    );
  // An edit not rendered yet: its timer not run, the preview not shown.
  let pending = false;

  let version = 0;
  let lastShown = -1;
  const check = (step: string) => {
    // Invariant 6: shown, nothing pending, a granted image waits only
    // while a caret is in its block (§12): granted, it is shown at once,
    // and a caret leaving shows it.
    if (preview.visible && !pending) {
      for (const box of Array.from(
        container.querySelectorAll<HTMLElement>(".remote-image-case"),
      )) {
        const src = box.dataset.imageSource ?? "";
        if (!images.granted(src)) continue;
        // Invariant 7: shown once in this view, it stays (§12).
        if (everShown.has(src)) {
          problems.push(`${step}: ${src} shown before, now its case`);
        }
        if (!underCaret(imageLines(box, src))) {
          problems.push(
            `${step}: ${box.dataset.imageSource} granted, not shown`,
          );
        }
      }
    }
    const shown = shownVersion();
    // Invariant 1: what is shown never goes back.
    if (shown < lastShown)
      problems.push(`${step}: v${shown} after v${lastShown}`);
    lastShown = Math.max(lastShown, shown);
    // What is filled in belongs to its own placeholder.
    for (const formula of Array.from(
      container.querySelectorAll<HTMLElement>(".math"),
    )) {
      const tex = formula.querySelector("annotation")?.textContent;
      if (tex !== undefined && tex !== formula.dataset.tex) {
        problems.push(`${step}: formula ${tex} in ${formula.dataset.tex}`);
      }
    }
    for (const diagram of Array.from(
      container.querySelectorAll<HTMLElement>(".mermaid"),
    )) {
      const drawn = diagram.querySelector("svg")?.textContent;
      if (drawn !== undefined && drawn !== diagram.dataset.source) {
        problems.push(`${step}: wrong diagram in ${diagram.dataset.source}`);
      }
    }
    for (const image of Array.from(container.querySelectorAll("img"))) {
      const src = image.getAttribute("src") ?? "";
      // Invariant 4: shown, no image the reader hasn't granted (§3, §4, §8).
      if (preview.visible && !images.granted(src)) {
        problems.push(`${step}: ${src} shown, not granted`);
      }
      // Invariant 5: none loaded for the first time under a caret (§12).
      if (everShown.has(src)) continue;
      everShown.add(src);
      if (underCaret(imageLines(image, src))) {
        problems.push(`${step}: ${src} loaded under a caret`);
      }
    }
  };

  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let i = 0; i < steps && problems.length === 0; i++) {
    const action = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
    const renders = counter("preview.render");
    const wasVisible = preview.visible;
    let step: string;
    if (action === 0) {
      const body = tc.draw(gs.sampledFrom(BODIES));
      version++;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: `v${version}\n\n${body}`,
        },
      });
      step = `edit v${version} ${JSON.stringify(body)}`;
      pending = true;
    } else if (action === 1) {
      preview.show();
      step = "show";
      pending = false;
    } else if (action === 2) {
      preview.hide();
      step = "hide";
    } else if (action === 3) {
      vi.advanceTimersByTime(RENDER_DELAY_MS);
      step = "timer";
      if (preview.visible) pending = false;
    } else if (action === 5) {
      const src = tc.draw(gs.sampledFrom(IMAGES));
      const grant = tc.draw(
        gs.sampledFrom(["image", "opening", "always", "revoke", "fail"]),
      );
      if (grant === "image") images.grantImage(src);
      else if (grant === "opening") images.grantDocument(false);
      else if (grant === "always") images.grantDocument(true);
      else if (grant === "revoke") images.revoke();
      else
        container
          .querySelector(`img[src="${src}"]`)
          ?.dispatchEvent(new Event("error"));
      step = `${grant} ${src}`;
    } else if (action === 6 || action === 7) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: view.state.doc.length }),
      );
      if (action === 6) {
        view.dispatch({ selection: { anchor: at } });
        step = `caret at ${at}`;
      } else {
        // The other's caret, or none: arrived now.
        const gone = tc.draw(gs.booleans());
        others = gone
          ? []
          : [
              {
                name: "o",
                color: "#336699",
                anchor: at,
                head: at,
              } as RemotePresence,
            ];
        shown++;
        for (const listener of presenceListeners) listener();
        step = gone ? "other gone" : `other at ${at}`;
      }
    } else if (action === 8) {
      // One gesture (AGENTS.md §1.6): shown, the document granted, the
      // reader's caret into the first image's block, checked there, then
      // out of it.
      const at = view.state.doc.toString().indexOf("![");
      if (at < 0) continue;
      view.dispatch({ selection: { anchor: at } });
      preview.show();
      pending = false;
      images.grantDocument(false);
      await tick();
      check(`caret into the image at ${at}`);
      view.dispatch({ selection: { anchor: 0 } });
      step = "caret out of the image";
    } else if (action === 9) {
      // One gesture: the other types at the end, after an image, and the
      // text is rendered again with their caret there.
      const end = view.state.doc.length;
      others = [
        {
          name: "o",
          color: "#336699",
          anchor: end,
          head: end,
        } as RemotePresence,
      ];
      shown++;
      for (const listener of presenceListeners) listener();
      view.dispatch({ changes: { from: end, insert: " x" } });
      vi.advanceTimersByTime(RENDER_DELAY_MS);
      if (preview.visible) pending = false;
      else pending = true;
      step = "the other types at the end";
    } else {
      if (held.length === 0) continue;
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: held.length - 1 }),
      );
      const [released] = held.splice(at, 1);
      released?.release();
      step = `release ${released?.label}`;
    }
    await tick();
    // Invariant 3: hidden, nothing renders.
    if (
      !wasVisible &&
      !preview.visible &&
      counter("preview.render") > renders
    ) {
      problems.push(`${step}: rendered while hidden`);
    }
    check(step);
  }

  // Shown, and everything let through: the current text, fully drawn —
  // after one more rendering, which tries again a type that failed to
  // load (`off`) during the first. The carets on the first line, which
  // holds no image: every image granted is shown.
  // (Not `getTimerCount`: CodeMirror sets timers of its own.)
  view.dispatch({ selection: { anchor: 0 } });
  others = [];
  shown++;
  for (const listener of presenceListeners) listener();
  for (const _ of [1, 2]) {
    preview.show();
    do {
      vi.advanceTimersByTime(RENDER_DELAY_MS);
      for (const released of held.splice(0)) released.release();
      await tick();
    } while (held.length > 0);
  }
  check("end");
  if (shownVersion() !== version) {
    problems.push(`end: shows v${shownVersion()}, text is v${version}`);
  }
  for (const formula of Array.from(container.querySelectorAll(".math"))) {
    if (!formula.querySelector(".katex"))
      problems.push("end: formula not drawn");
  }
  for (const diagram of Array.from(container.querySelectorAll(".mermaid"))) {
    if (!diagram.querySelector("svg, .render-error")) {
      problems.push("end: diagram not drawn");
    }
  }
  for (const box of Array.from(
    container.querySelectorAll<HTMLElement>(".remote-image-case"),
  )) {
    if (images.granted(box.dataset.imageSource ?? "")) {
      problems.push(`end: ${box.dataset.imageSource} granted, not shown`);
    }
  }
  const sources = remoteImageSources(view.state.doc.toString());
  if (JSON.stringify(told) !== JSON.stringify(sources)) {
    problems.push(`end: told ${told}, the text holds ${sources}`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    throw new Error(problems.join("\n"));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resetCounters();
});
afterEach(() => vi.useRealTimers());

describe("preview interleavings (property)", () => {
  test(
    "shows the latest text, never goes back, and does no work for what is not shown",
    () => hegel.testAsync(scenario, { testCases: 1000 }),
    // Only stops a test that hangs: every outcome is drawn, never timed.
    // 7 s alone, 52 to 56 s amid the whole suite (16 cores) — at the
    // edge of the 60 s it had.
    240_000,
  );
});
