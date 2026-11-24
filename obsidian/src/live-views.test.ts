// One live view per document (decision 16), its order drawn by Hegel
// (AGENTS.md §1.6): views claim a document and let it go, in any order;
// each closing ends when the test says — or, for a view let go while its
// claim still waits, once that claim has resolved and the test says, as
// the end of its opening does. Checked at each step: LV1 (at most one view
// holds a document, a refused one takes nothing), LV3 (letting go of a
// document held by another changes nothing); at each grant, LV2 (every
// closing let go before the claim has ended); at rest, LV4 (no closing
// awaited).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { LiveViews } from "./live-views.js";

const DOCS = ["doc1", "doc2"] as const;
const VIEWS = ["a", "b", "c"] as const;
type Doc = (typeof DOCS)[number];
type View = (typeof VIEWS)[number];

/** A closing, ended when the test says. */
interface Closing {
  doc: Doc;
  ended: boolean;
  end: () => void;
}

/** Every microtask through: what was resolved has had its effect. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LiveViews", () => {
  test("a view claims a free document, another is refused until it is let go", async () => {
    const views = new LiveViews<string>();
    expect(await views.claim("doc", "a")).toBe(true);
    expect(await views.claim("doc", "b")).toBe(false);
    expect(views.live("doc")).toBe("a");
    let free = () => {};
    views.release(
      "doc",
      "a",
      new Promise<void>((resolve) => {
        free = resolve;
      }),
    );
    let granted = false;
    const claimed = views.claim("doc", "b").then((ok) => {
      granted = ok;
    });
    await turn();
    expect(granted).toBe(false);
    free();
    await claimed;
    expect(granted).toBe(true);
    expect(views.closings()).toBe(0);
  });

  test("LV2: a claim waits for every closing let go before it, the last one ending first (the property's draws)", async () => {
    // draw_1…draw_14: release doc1 by a, twice; claim doc1 by a; end the
    // second closing.
    const views = new LiveViews<string>();
    const ends: (() => void)[] = [];
    const closing = () =>
      new Promise<void>((resolve) => {
        ends.push(resolve);
      });
    views.release("doc1", "a", closing());
    views.release("doc1", "a", closing());
    let granted = false;
    const claimed = views.claim("doc1", "a").then((ok) => {
      granted = ok;
    });
    ends[1]?.();
    await turn();
    expect(granted).toBe(false);
    ends[0]?.();
    await claimed;
    expect(granted).toBe(true);
    expect(views.closings()).toBe(0);
  });

  test("LV1–LV4, whatever the order of the claims, the releases and the closings' ends", async () => {
    await hegel.testAsync(
      async (tc) => {
        const views = new LiveViews<View>();
        /** Who holds each document, as the registry should say. */
        const holder = new Map<Doc, View>();
        const closings: Closing[] = [];
        /** Claims still waiting, by view and document. */
        const waiting = new Map<string, Promise<boolean>>();
        const problems: string[] = [];

        const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
        for (let i = 0; i < steps; i++) {
          const move = tc.draw(
            gs.sampledFrom(["claim", "release", "end"] as const),
          );
          const doc = tc.draw(gs.sampledFrom(DOCS));
          const view = tc.draw(gs.sampledFrom(VIEWS));
          if (move === "claim") {
            const held = holder.get(doc);
            const before = closings.filter((c) => c.doc === doc);
            const claim = views.claim(doc, view);
            if (held !== undefined && held !== view) {
              // LV1: refused, nothing taken.
              if ((await claim) !== false) problems.push("LV1: not refused");
            } else {
              holder.set(doc, view);
              const key = `${view}:${doc}`;
              waiting.set(key, claim);
              void claim.then((granted) => {
                if (waiting.get(key) === claim) waiting.delete(key);
                if (!granted) problems.push("LV1: a free document refused");
                // LV2: every closing let go before the claim has ended.
                if (before.some((c) => !c.ended)) {
                  problems.push("LV2: granted before a closing ended");
                }
              });
            }
          } else if (move === "release") {
            let end = () => {};
            const ended = new Promise<void>((resolve) => {
              end = resolve;
            });
            const closing: Closing = { doc, ended: false, end };
            // Let go while its claim waits: its closing is the end of its
            // opening, after that claim (as `opening.ended`).
            const own = waiting.get(`${view}:${doc}`);
            const closed = own ? own.then(() => ended) : ended;
            void closed.then(() => {
              closing.ended = true;
            });
            closings.push(closing);
            if (holder.get(doc) === view) holder.delete(doc);
            views.release(doc, view, closed);
          } else {
            const open = closings.filter((c) => c.doc === doc);
            if (open.length > 0) {
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: open.length - 1 }),
              );
              open[at]?.end();
            }
          }
          await turn();
          // LV1, LV3: the registry says who holds each document.
          for (const id of DOCS) {
            if (views.live(id) !== holder.get(id)) {
              problems.push(`LV1/LV3: ${id} held by ${views.live(id)}`);
            }
          }
          expect(problems).toEqual([]);
        }
        // At rest: every closing ended, every claim answered.
        for (const closing of closings) closing.end();
        await turn();
        await Promise.all(waiting.values());
        await turn();
        expect(problems).toEqual([]);
        // LV4: no closing awaited any more.
        expect(views.closings()).toBe(0);
      },
      { testCases: 400 },
    );
  }, 300_000);
});
