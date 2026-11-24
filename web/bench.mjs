// `npm run bench [-- --update]`: runs src/bench/bench.benchmark.ts;
// `--update` records the results as bench/reference.json.
import { spawnSync } from "node:child_process";

const update = process.argv.includes("--update");
const result = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.bench.config.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, ...(update && { BENCH_UPDATE: "1" }) },
  },
);
process.exit(result.status ?? 1);
