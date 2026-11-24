import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import type { ViteUserConfig } from "vitest/config";

/** What every vitest config needs to load Svelte components (ADR-0016). */
export const svelteSupport: ViteUserConfig = {
  plugins: [svelte()],
  resolve: {
    // Svelte's client runtime (mount), not its server one — only for
    // `svelte` itself: a global "browser" condition would also pick
    // loro-crdt's bundler build, which doesn't load under Node.
    alias: [
      {
        find: /^svelte$/,
        replacement: fileURLToPath(
          new URL("node_modules/svelte/src/index-client.js", import.meta.url),
        ),
      },
    ],
  },
};
