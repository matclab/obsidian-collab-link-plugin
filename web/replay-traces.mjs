// `npm run replay -- trace-A.json trace-B.json`: replays downloaded
// scenario traces (src/trace/replay-file.test.ts).
import { spawnSync } from "node:child_process";
import path from "node:path";

const files = process.argv.slice(2).map((file) => path.resolve(file));
if (files.length === 0) {
  console.error("usage: npm run replay -- <trace.json>...");
  process.exit(2);
}
const result = spawnSync(
  "npx",
  ["vitest", "run", "src/trace/replay-file.test.ts"],
  { stdio: "inherit", env: { ...process.env, TRACE_FILES: files.join(",") } },
);
process.exit(result.status ?? 1);
