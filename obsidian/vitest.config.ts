import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { svelteSupport } from "../web/vitest.shared.js";

// The page's components, compiled as for its own tests; `obsidian`, which
// exists only inside Obsidian, replaced by a fake (phase 14, decision 10).
export default defineConfig({
  ...svelteSupport,
  resolve: {
    alias: [
      ...(svelteSupport.resolve?.alias as {
        find: RegExp;
        replacement: string;
      }[]),
      {
        find: /^obsidian$/,
        replacement: fileURLToPath(
          new URL("src/test-support/obsidian.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
