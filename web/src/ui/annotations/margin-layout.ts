/** Space between two cards in the margin, in pixels. */
export const GAP = 8;

/** Where each card goes in the margin, from where
 * its passage stands (`want`) and its height: in the text's order, never
 * overlapping, never above the margin. The active card stands exactly at
 * its passage when the cards above it fit, the others moved around it;
 * without one, each goes as high as it may, at its passage or right under
 * the card above. */
export function placeCards(
  items: readonly { id: string; want: number; height: number }[],
  activeId: string | undefined,
): Map<string, number> {
  const sorted = items
    .map((item, at) => ({ ...item, want: Math.max(0, item.want), at }))
    .sort((x, y) => x.want - y.want || x.at - y.at);
  const tops = sorted.map((item) => item.want);
  const bottom = (i: number) => (tops[i] ?? 0) + (sorted[i]?.height ?? 0) + GAP;
  const a = sorted.findIndex((item) => item.id === activeId);
  // Downward first, every card but the active one: at its passage, or
  // right under the card above.
  for (let i = 1; i < sorted.length; i++) {
    if (i !== a) tops[i] = Math.max(sorted[i]?.want ?? 0, bottom(i - 1));
  }
  if (a > 0) {
    // Then the cards above the active one go up, only as far as it needs.
    for (let i = a - 1; i >= 0; i--) {
      const room = (tops[i + 1] ?? 0) - (sorted[i]?.height ?? 0) - GAP;
      tops[i] = Math.min(tops[i] ?? 0, room);
    }
    // They don't fit: everything goes down by what is missing.
    const missing = -(tops[0] ?? 0);
    if (missing > 0) {
      for (let i = 0; i < tops.length; i++) tops[i] = (tops[i] ?? 0) + missing;
    }
  }
  return new Map(sorted.map((item, i) => [item.id, tops[i] ?? 0]));
}
