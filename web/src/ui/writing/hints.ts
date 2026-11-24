/** What the first visit has already shown in this browser (ADR-0064):
 * the banner for each role (AC1, AC2), each hint (AC6). Kept in the
 * view's preferences, never shared; unreadable, all is shown once more. */

export type Hint = "welcome-edit" | "welcome-suggest" | "markup" | "diagram";

export const HINTS_KEY = "obsidian-collab:hints";

export function seenHints(storage: Storage | undefined): Set<string> {
  try {
    const list: unknown = JSON.parse(storage?.getItem(HINTS_KEY) ?? "[]");
    return new Set(
      Array.isArray(list)
        ? list.filter((name): name is string => typeof name === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export function rememberHint(storage: Storage | undefined, hint: Hint): void {
  const seen = seenHints(storage);
  seen.add(hint);
  try {
    storage?.setItem(HINTS_KEY, JSON.stringify([...seen]));
  } catch {
    // Storage refused: shown again at the next visit.
  }
}
