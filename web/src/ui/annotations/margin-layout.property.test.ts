import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { GAP, placeCards } from "./margin-layout.js";

// Cards in the margin (phase 10, decision 7): each level with its passage
// as far as the others allow, the active one exactly there when it fits.
describe("placeCards (property)", () => {
  test(
    "no overlap, the text's order, the active one at its passage, none further than needed",
    () =>
      hegel.test(
        (tc) => {
          const n = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
          const items = Array.from({ length: n }, (_, i) => ({
            id: `c${i}`,
            want: tc.draw(gs.integers({ minValue: 0, maxValue: 1500 })),
            height: tc.draw(gs.integers({ minValue: 10, maxValue: 300 })),
          }));
          const pick = tc.draw(gs.integers({ minValue: -1, maxValue: n - 1 }));
          const activeId = pick >= 0 ? `c${pick}` : undefined;
          const tops = placeCards(items, activeId);

          const placed = items
            .map((item, at) => ({
              ...item,
              at,
              top: tops.get(item.id) ?? Number.NaN,
            }))
            .sort((x, y) => x.want - y.want || x.at - y.at);
          for (const card of placed) {
            if (!(card.top >= 0))
              throw new Error(`above the margin: ${card.id}`);
          }
          for (let i = 1; i < placed.length; i++) {
            const above = placed[i - 1];
            const card = placed[i];
            if (!above || !card) continue;
            if (card.top < above.top + above.height + GAP) {
              throw new Error(`overlap or order: ${above.id}, ${card.id}`);
            }
          }
          const a = placed.findIndex((card) => card.id === activeId);
          if (a < 0) {
            // Greedy, downward: at its passage, or right under the one above.
            for (const [i, card] of placed.entries()) {
              const above = placed[i - 1];
              const floor = above ? above.top + above.height + GAP : 0;
              if (card.top !== Math.max(card.want, floor)) {
                throw new Error(
                  `${card.id} at ${card.top}, not ${Math.max(card.want, floor)}`,
                );
              }
            }
            return;
          }
          const active = placed[a];
          if (!active) return;
          const above = placed
            .slice(0, a)
            .reduce((sum, c) => sum + c.height + GAP, 0);
          if (above <= active.want && active.top !== active.want) {
            throw new Error(
              `active at ${active.top}, its passage at ${active.want}: ${JSON.stringify(placed)}`,
            );
          }
          if (above > active.want && placed[0]?.top !== 0) {
            throw new Error("pushed down further than needed");
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
