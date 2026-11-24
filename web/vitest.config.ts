import { defineConfig } from "vitest/config";
import { svelteSupport } from "./vitest.shared.js";

export default defineConfig({
  ...svelteSupport,
  test: {
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    // A hang detector, not a measure (§6 of AGENTS.md: counters): tests
    // of a second or two alone pass 5 s on a loaded machine.
    testTimeout: 30_000,
    // Threads rather than a process per file: half the time, measured
    // 2026-11-20 on src/ui (60 s against 114 s), the disk barely touched
    // either way. At most four, as the machine shared with its user asks.
    pool: "threads",
    maxWorkers: 4,
  },
});
