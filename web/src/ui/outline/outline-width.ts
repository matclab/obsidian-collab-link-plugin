// The outline's width (ADR-0062, PV1, PV2): in rem, within bounds, set by
// its handle, kept by this device. Pure.

export const DEFAULT_OUTLINE_WIDTH = 15;
export const MIN_OUTLINE_WIDTH = 12;
export const MAX_OUTLINE_WIDTH = 28;

/** Where this device keeps the width chosen (PV2): a preference, never
 * shared. */
export const OUTLINE_WIDTH_KEY = "obsidian-collab:outline-width";

const clamp = (width: number) =>
  Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, width));

/** The width kept, or none if what is kept is not a width within bounds:
 * ignored, never an error. */
export function storedWidth(
  kept: string | null | undefined,
): number | undefined {
  if (!kept || !/^\d+(?:\.\d+)?$/.test(kept)) return undefined;
  const width = Number(kept);
  return width >= MIN_OUTLINE_WIDTH && width <= MAX_OUTLINE_WIDTH
    ? width
    : undefined;
}

/** The width for a pointer `pixels` from the column's left edge, `remPixels`
 * to a rem: to a quarter of a rem, within bounds. */
export function widthFromPixels(pixels: number, remPixels: number): number {
  return clamp(Math.round((pixels / remPixels) * 4) / 4);
}

/** The width after `key` on the handle, or none if the key does nothing. */
export function keyedWidth(width: number, key: string): number | undefined {
  switch (key) {
    case "ArrowRight":
      return clamp(width + 1);
    case "ArrowLeft":
      return clamp(width - 1);
    case "Home":
      return MIN_OUTLINE_WIDTH;
    case "End":
      return MAX_OUTLINE_WIDTH;
    case "Enter":
      return DEFAULT_OUTLINE_WIDTH;
    default:
      return undefined;
  }
}
