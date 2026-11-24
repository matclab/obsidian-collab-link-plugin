import type Katex from "katex";

/** What the page uses of KaTeX: the preview's formulas and the editor's
 *. */
export type KatexModule = Pick<typeof Katex, "renderToString">;

// Once per page, however many previews and editors.
let katexLoading: Promise<KatexModule> | undefined;
let bringSheet: (() => void) | undefined;

/** How KaTeX's sheet comes, run before its first load: the page links its
 * hashed sheet (`main.ts`); the plugin brings none, its styles.css holds
 * it, and Obsidian's directory refuses a plugin's source that creates an
 * element to load one. */
export function bringKatexSheet(bring: () => void): void {
  bringSheet = bring;
}

/** KaTeX, loaded on first need with its stylesheet (ADR-0021 §6). */
export function loadKatex(): Promise<KatexModule> {
  katexLoading ??= (() => {
    bringSheet?.();
    return import("katex").then((module) => module.default);
  })();
  katexLoading.catch(() => {
    katexLoading = undefined; // tried again at the next rendering
  });
  return katexLoading;
}

/** ADR-0021 §3: no `\href`, `\url`, `\html…`; an error shows in place;
 * a recursive macro stops at once. */
export const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  maxSize: 20,
  maxExpand: 1000,
  strict: "ignore",
} as const;
