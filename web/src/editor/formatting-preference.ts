/** Where this browser keeps its choice of the source over the formatted
 * text: a preference, never shared. */
export const FORMATTING_KEY = "obsidian-collab:editor";

/** Formatted, unless this device chose the source, in `storage` (the
 * page's `localStorage`, the plugin's own). Without storage (private
 * window, blocked site data): formatted. */
export function storedFormatting(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(FORMATTING_KEY) !== "source";
  } catch {
    return true;
  }
}

/** Keeps the choice, where storage allows; the default is not written. */
export function storeFormatting(
  formatted: boolean,
  storage: Storage | undefined,
): void {
  try {
    if (formatted) storage?.removeItem(FORMATTING_KEY);
    else storage?.setItem(FORMATTING_KEY, "source");
  } catch {
    // Kept for this page only.
  }
}
