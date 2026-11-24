import { defineConfig } from "vitest/config";
import { svelteSupport } from "./vitest.shared.js";

export default defineConfig({
  ...svelteSupport,
  test: {
    include: ["**/*.e2e.test.ts"],
  },
});
