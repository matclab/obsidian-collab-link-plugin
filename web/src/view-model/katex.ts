import type Katex from "katex";

/** What the page uses of KaTeX: the preview's formulas and the editor's
 *. */
export type KatexModule = Pick<typeof Katex, "renderToString">;

/** Replaced by the build: the page's hashed sheet; empty in the plugin,
 * whose `styles.css` already holds it; absent
 * under vitest, which loads no sheet. */
declare const KATEX_STYLESHEET: string | undefined;
const KATEX_STYLESHEET_PATH =
  typeof KATEX_STYLESHEET === "string" ? KATEX_STYLESHEET : "";

// Once per page, however many previews and editors.
let katexLoading: Promise<KatexModule> | undefined;

/** KaTeX, loaded on first need with its stylesheet (ADR-0021 §6). */
export function loadKatex(): Promise<KatexModule> {
  katexLoading ??= (() => {
    // Served with the page, its hashed name given by the build
    // (`build-page.mjs`); relative, so that the page also works under a
    // path of a reverse proxy.
    if (KATEX_STYLESHEET_PATH) {
      const sheet = document.createElement("link");
      sheet.rel = "stylesheet";
      sheet.href = KATEX_STYLESHEET_PATH;
      document.head.append(sheet);
    }
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
