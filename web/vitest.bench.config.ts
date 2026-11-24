import { defineConfig } from "vitest/config";
import { svelteSupport } from "./vitest.shared.js";

export default defineConfig({
  ...svelteSupport,
  test: {
    include: ["src/bench/**/*.benchmark.ts"],
  },
});
