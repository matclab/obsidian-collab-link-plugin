// @vitest-environment jsdom
// Inserting images in a view under a controlled order (AGENTS.md §1.6;
// phase 38c, IM1, IM2): the server's limits read (or none), the editor
// made read-only (the document deleted) or taken out, images chosen or
// dropped, the files picked, the view closed: each when Hegel says. The
// uploader and the file picker are fakes that count what is asked.
//
// At every step: nothing offered to an editor read-only or gone when the
// limits came (IM1); the uploader made once, at the first insertion, and
// destroyed with the view, none made once it is closed (IM2); each
// insertion reaches it.
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test, vi } from "vitest";
import type { PageConfig } from "../account/config.js";
import { type ImageSlot, imageInserter } from "../editor/image-insertion.js";
import type { AttachedImages } from "../view-model/attached-images.js";
import { offerImageInsertion } from "./view-images.js";

const seen = vi.hoisted(() => ({
  uploaders: [] as { inserted: number; destroyed: number }[],
  /** The pickers open, each answered when Hegel says. */
  picking: [] as ((files: File[]) => void)[],
}));
vi.mock("../ui/images/image-upload.js", () => ({
  createImageUploader: () => {
    const counts = { inserted: 0, destroyed: 0 };
    seen.uploaders.push(counts);
    return {
      insert: () => {
        counts.inserted += 1;
      },
      destroy: () => {
        counts.destroyed += 1;
      },
    };
  },
}));
vi.mock("../ui/images/choose-images.js", () => ({
  chooseImages: () =>
    new Promise<File[]>((resolve) => {
      seen.picking.push(resolve);
    }),
}));

type TC = Parameters<Parameters<typeof hegel.testAsync>[0]>[0];

const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One scenario, each source of order drawn from `tc`. */
const imagesScenario = async (tc: TC): Promise<void> => {
  seen.uploaders.length = 0;
  seen.picking.length = 0;
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const view = new EditorView({
    state: EditorState.create({ doc: "text" }),
    parent: root,
  });
  let limits: (found: PageConfig["attachments"]) => void = () => {};
  const stops: (() => void)[] = [];
  offerImageInsertion({
    limits: new Promise((resolve) => {
      limits = resolve;
    }),
    view,
    parent: root,
    root,
    apiBase: "https://collab.test",
    documentId: "doc",
    key: {} as CryptoKey,
    roleSecret: () => "secret",
    fetch: () => Promise.reject(new Error("offline")),
    attached: {} as AttachedImages,
    notify: () => {},
    stops,
    closed: () => closed,
  });

  let limitsIn: "no" | "some" | "none" = "no";
  let offered = false;
  let readOnly = false;
  let gone = false;
  let closed = false;
  let inserts = 0;
  let madeAtClose = 0;
  const slot = { release: () => {} } as unknown as ImageSlot;
  // Insertions twice as often: their uploader is shared.
  const moves = [
    "limits",
    "read-only",
    "gone",
    "insert",
    "insert",
    "pick",
    "picked",
    "close",
  ] as const;
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
  for (let step = 0; step < steps; step++) {
    const move = tc.draw(gs.sampledFrom([...moves]));
    const inserter = view.state.facet(imageInserter);
    switch (move) {
      case "limits":
        if (limitsIn !== "no") break;
        // Mostly some: the server takes images.
        limitsIn =
          tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) > 0
            ? "some"
            : "none";
        offered = limitsIn === "some" && !readOnly && !gone;
        limits(
          limitsIn === "some"
            ? { imageBytes: 1_000_000, documentBytes: 10_000_000 }
            : undefined,
        );
        break;
      case "read-only":
        readOnly = true;
        view.dispatch({
          effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
        });
        break;
      case "gone":
        gone = true;
        view.dom.remove();
        break;
      case "insert":
        if (!inserter || closed) break;
        inserts += 1;
        inserter.insert(view, [new File(["x"], "a.png")], slot);
        break;
      case "pick":
        if (!inserter || closed) break;
        inserter.pick(view, slot);
        break;
      case "picked": {
        const answer = seen.picking.shift();
        if (!answer) break;
        const chosen = tc.draw(gs.booleans());
        // Chosen once the view is closed: nothing inserted.
        if (chosen && !closed) inserts += 1;
        answer(chosen ? [new File(["x"], "b.png")] : []);
        break;
      }
      case "close":
        if (closed) break;
        closed = true;
        for (const stop of stops.splice(0)) stop();
        madeAtClose = seen.uploaders.length;
        break;
    }
    await quiet();

    // IM1: offered only to an editor writable and there.
    expect(view.state.facet(imageInserter) !== undefined).toBe(offered);
    // IM2: made once, at the first insertion; each insertion reaches it.
    expect(seen.uploaders.length).toBe(inserts > 0 ? 1 : 0);
    expect(seen.uploaders[0]?.inserted ?? 0).toBe(inserts);
    // Destroyed with the view, once; none made after it.
    if (closed) {
      expect(seen.uploaders.length).toBe(madeAtClose);
      for (const uploader of seen.uploaders) expect(uploader.destroyed).toBe(1);
    }
  }
  view.destroy();
};

/** A `tc` that gives back recorded draws, in order (Hegel prints them as
 * `draw_1`, `draw_2`… when a case fails). */
function replay(draws: readonly (number | boolean | string)[]) {
  let next = 0;
  const tc = {
    draw: () => {
      if (next >= draws.length) throw new Error("more draws than recorded");
      return draws[next++];
    },
  } as unknown as TC;
  return { tc, done: () => next === draws.length };
}

describe("inserting images in a view under a controlled order", () => {
  test(
    "IM1, IM2 at every step, whatever the order",
    () => hegel.testAsync(imagesScenario, { testCases: 400 }),
    600_000,
  );
  // Found by the property (phase 38c): a picker open as the view closes,
  // files chosen after — an uploader was made, never destroyed, and sent
  // them.
  test("nothing is made once the view is closed", async () => {
    const { tc, done } = replay([
      4,
      "limits",
      1,
      "pick",
      "close",
      "picked",
      true,
    ]);
    await imagesScenario(tc);
    expect(done()).toBe(true);
  });
});
