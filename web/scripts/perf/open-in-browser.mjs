// Opens a document's link in Chromium with `?perf` and reports what the
// page itself measures (`[perf] connect→settled, navigation→settled`):
// the first load in a new profile, then reloads (HTTP cache, service
// worker and local state in place). `--via` replaces the link's origin,
// to go through latency-proxy.mjs. playwright-core is not a dependency of
// web/: it is taken from choice/render/ (or `--playwright <dir>`).
//
//   node scripts/perf/open-in-browser.mjs --link '<link>' [--reloads 3] [--via http://127.0.0.1:18081]
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { args } from "./args.mjs";

const options = args({
  link: "",
  reloads: 3,
  via: "",
  chromium: "/usr/bin/chromium",
  playwright: resolve(import.meta.dirname, "../../../choice/render/"),
});
if (!options.link) {
  console.error("--link is required");
  process.exit(2);
}
const { chromium } = createRequire(`${options.playwright}/`)("playwright-core");

const url = new URL(options.link);
if (options.via) {
  const via = new URL(options.via);
  url.protocol = via.protocol;
  url.host = via.host;
}
url.searchParams.set("perf", "");

// Here, Chromium loads pages only as one process (docs: browser tooling).
process.env.XDG_CONFIG_HOME ??= mkdtempSync(join(tmpdir(), "oc-perf-config-"));
process.env.XDG_CACHE_HOME ??= mkdtempSync(join(tmpdir(), "oc-perf-cache-"));
const browser = await chromium.launch({
  executablePath: options.chromium,
  args: ["--single-process", "--disable-crashpad-for-testing"],
});
const page = await (await browser.newContext()).newPage();
// The page asks a name the first time a link that writes opens it
// (phase 10b): one already kept, so that nothing waits for an answer.
await page.addInitScript(() =>
  localStorage.setItem("obsidian-collab:pseudonym", "perf"),
);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
// Settled, then (phase 18) every signature verified: the view doesn't
// wait for them.
const settled = () =>
  new Promise((done) => {
    const run = {};
    const listener = (message) => {
      const text = message.text();
      const found = text.match(/\[perf\] connect→settled: (\d+) ms, navigation→settled: (\d+) ms/);
      if (found) {
        run.connectMs = Number(found[1]);
        run.navigationMs = Number(found[2]);
      }
      const signed = text.match(/\[perf\] connect→signatures verified: (\d+) ms, (\d+) verified/);
      if (signed) {
        run.signaturesMs = Number(signed[1]);
        run.verified = Number(signed[2]);
      }
      if (run.connectMs !== undefined && run.signaturesMs !== undefined) {
        page.off("console", listener);
        done(run);
      }
    };
    page.on("console", listener);
  });

const runs = [];
let waiting = settled();
await page.goto(url.href);
runs.push({ load: "first", ...(await waiting) });
for (let i = 0; i < options.reloads; i++) {
  waiting = settled();
  await page.reload();
  runs.push({ load: "reload", ...(await waiting) });
}
const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
await browser.close();
console.log(JSON.stringify({ runs, serviceWorker: controlled, errors }));
