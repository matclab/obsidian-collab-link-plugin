/** A rendered top-level block: the source lines it comes from, from 0,
 * `lineEnd` excluded (`data-line`, `data-line-end`), and where
 * it stands in the rendering, in pixels from its top. */
export interface BlockSpan {
  line: number;
  lineEnd: number;
  top: number;
  bottom: number;
}

type Point = readonly [line: number, offset: number];

/** The blocks as a path: each block's first line at its top, its end at
 * its bottom, straight in between. A point that would go back up, in
 * lines or in pixels, or above the start, is left out: a stale or tangled
 * reading never sends the other column backwards. */
function path(blocks: readonly BlockSpan[]): Point[] {
  const points: Point[] = [];
  for (const block of blocks) {
    for (const point of [
      [block.line, block.top],
      [block.lineEnd, block.bottom],
    ] as const) {
      const [line, offset] = points[points.length - 1] ?? [0, 0];
      if (point[0] >= line && point[1] >= offset) points.push(point);
    }
  }
  return points;
}

/** Along `points`, from coordinate `from` to the other: straight between
 * the points on either side of `x`; at a point, the last one there (a
 * block's first line is its top, not the bottom of the block before it,
 * which ends there); before the path, its start (the lines above the
 * first block lead to its top); past it, its end; without one, 0. */
function along(points: readonly Point[], x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  const next = points.findIndex((point) => point[from] > x);
  const before = points[(next < 0 ? points.length : next) - 1];
  const after = points[next];
  if (!before) return after?.[to] ?? 0;
  if (!after || before[from] === x) return before[to];
  const share = (x - before[from]) / (after[from] - before[from]);
  return before[to] + share * (after[to] - before[to]);
}

/** Where source line `line` (fractional: a share of the way down it)
 * stands in the rendering. */
export function previewOffset(
  blocks: readonly BlockSpan[],
  line: number,
): number {
  return along(path(blocks), line, 0);
}

/** Which source line (fractional) stands at `offset` in the rendering. */
export function sourceLine(
  blocks: readonly BlockSpan[],
  offset: number,
): number {
  return along(path(blocks), offset, 1);
}
