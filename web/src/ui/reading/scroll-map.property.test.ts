import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { type BlockSpan, previewOffset, sourceLine } from "./scroll-map.js";

const EPSILON = 1e-6;

// Blocks as the preview lays them out: in the source's order, each over at
// least one line and some height, with blank lines and margins between.
const laidOut = (tc: hegel.TestCase): BlockSpan[] => {
  const n = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
  const blocks: BlockSpan[] = [];
  let line = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  let top = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
  for (let i = 0; i < n; i++) {
    const lineEnd = line + tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
    const bottom = top + tc.draw(gs.integers({ minValue: 1, maxValue: 400 }));
    blocks.push({ line, lineEnd, top, bottom });
    line = lineEnd + tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    top = bottom + tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
  }
  return blocks;
};

// Anything at all: a stale or partial reading must not break the sync.
const arbitrary = (tc: hegel.TestCase): BlockSpan[] => {
  const n = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
  const value = () => tc.draw(gs.integers({ minValue: -50, maxValue: 500 }));
  return Array.from({ length: n }, () => ({
    line: value(),
    lineEnd: value(),
    top: value(),
    bottom: value(),
  }));
};

describe("scroll map (property)", () => {
  test(
    "within a block, a line and its offset go there and back",
    () =>
      hegel.test(
        (tc) => {
          const blocks = laidOut(tc);
          const block =
            blocks[
              tc.draw(
                gs.integers({
                  minValue: 0,
                  maxValue: Math.max(0, blocks.length - 1),
                }),
              )
            ];
          if (!block) return;
          // Its end excluded: the next block's line, or a blank line.
          const share =
            tc.draw(gs.integers({ minValue: 0, maxValue: 999 })) / 1000;
          const line = block.line + share * (block.lineEnd - block.line);
          const at = previewOffset(blocks, line);
          if (at < block.top - EPSILON || at > block.bottom + EPSILON) {
            throw new Error(
              `line ${line} at ${at}, outside its block ${JSON.stringify(block)}`,
            );
          }
          const back = sourceLine(blocks, at);
          if (Math.abs(back - line) > EPSILON) {
            throw new Error(`line ${line} → ${at} → ${back}`);
          }
          const offset = block.top + share * (block.bottom - block.top);
          const there = previewOffset(blocks, sourceLine(blocks, offset));
          if (Math.abs(there - offset) > EPSILON) {
            throw new Error(`offset ${offset} → ${there}`);
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );

  test(
    "both ways, never back up, never outside the text, whatever was read",
    () =>
      hegel.test(
        (tc) => {
          const blocks = tc.draw(gs.booleans()) ? laidOut(tc) : arbitrary(tc);
          const a = tc.draw(gs.integers({ minValue: -10, maxValue: 600 })) / 4;
          const b = tc.draw(gs.integers({ minValue: -10, maxValue: 600 })) / 4;
          const [low, high] = a <= b ? [a, b] : [b, a];
          for (const [name, map] of [
            ["previewOffset", previewOffset],
            ["sourceLine", sourceLine],
          ] as const) {
            const from = map(blocks, low);
            const to = map(blocks, high);
            if (!Number.isFinite(from) || !Number.isFinite(to)) {
              throw new Error(`${name}: not a number`);
            }
            if (from < 0 || to < from - EPSILON) {
              throw new Error(`${name}(${low}) = ${from}, (${high}) = ${to}`);
            }
          }
        },
        { testCases: 400 },
      ),
    60_000,
  );
});
