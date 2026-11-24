// Samples a server process from /proc: resident memory, CPU (both since
// the previous sample), and the size of its SQLite files. One JSON line
// per sample; Linux only.
//
//   node scripts/perf/server-stats.mjs --pid <pid> --db <path.sqlite3> [--interval 1000] [--seconds 60]
import { existsSync, readFileSync, statSync } from "node:fs";
import { args } from "./args.mjs";

const { pid, db, interval, seconds } = args({ pid: 0, db: "", interval: 1000, seconds: 60 });
const TICKS = 100; // CLK_TCK on Linux
const cpuTicks = () => {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return Number(fields[11]) + Number(fields[12]); // utime + stime
};
const rssKiB = () => Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1]);
const size = (path) => (existsSync(path) ? statSync(path).size : 0);

let previous = cpuTicks();
for (let elapsed = 0; elapsed < seconds * 1000; elapsed += interval) {
  await new Promise((resolve) => setTimeout(resolve, interval));
  if (!existsSync(`/proc/${pid}`)) break;
  const ticks = cpuTicks();
  console.log(
    JSON.stringify({
      t: (elapsed + interval) / 1000,
      rssMiB: Math.round(rssKiB() / 102.4) / 10,
      cpuPercent: Math.round(((ticks - previous) / TICKS / (interval / 1000)) * 1000) / 10,
      dbKiB: Math.round((size(db) + size(`${db}-wal`)) / 1024),
    }),
  );
  previous = ticks;
}
