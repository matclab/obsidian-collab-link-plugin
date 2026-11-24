// `npm audit`, with the exceptions written in docs/security/dependencies.md
// (AGENTS.md §5), as server/.cargo/audit.toml for `cargo audit`: fails on
// any advisory not listed here.
import { spawnSync } from "node:child_process";

const ALLOWED = new Map([
  // deepmerge 4.3.1, through @sveltejs/vite-plugin-svelte (tests only): it
  // merges the plugin's own options, never an outside input (2026-10-31).
  ["GHSA-gcqx-w48m-w2h4", "deepmerge"],
  // picomatch 4.0.7, through vitest, vite and svelte-check (tests and build
  // only): it compiles the project's own patterns, never an outside input
  // (2026-11-18).
  ["GHSA-fc5q-39xc-vjpf", "picomatch"],
]);

const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
const report = JSON.parse(result.stdout);
const unexpected = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    // A string: through another package, itself listed.
    if (typeof via === "string") continue;
    const id = via.url?.split("/").pop();
    if (ALLOWED.get(id) !== name) unexpected.push(`${name}: ${via.title} (${via.url})`);
  }
}
if (unexpected.length > 0) {
  console.error(`npm audit: ${unexpected.length} advisory not allowed\n${unexpected.join("\n")}`);
  process.exit(1);
}
console.info(
  `npm audit: ${Object.keys(report.vulnerabilities ?? {}).length} package(s) flagged, each by an allowed advisory (docs/security/dependencies.md)`,
);
