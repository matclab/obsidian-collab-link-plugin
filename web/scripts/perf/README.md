# Performance tooling (phase 9, 9e)

Relaunchable scripts, not tests: they measure the release binary, real browsers and the network, which `npm test` and `npm run bench` (jsdom, counters) don't. What they found is in `docs/phase-9-durcissement.md` (9e). Run from `web/`, after `npm run build` (the page), `npm run build:lib` (the library) and `cargo build --release` (the server). Outputs go to `perf-out/` (ignored).

| Script | What it does |
|---|---|
| `profile-document.mjs` | A document of the usage profile, deterministic: `--weeks 26 --hours 3 --chars 2000` (the profile), `--weeks 52 --hours 6 --chars 3000` (a year of intense use). Writes the two snapshots and `summary.json`. |
| `seed-document.mjs` | Creates a document on a server and journals a generated one into it (one snapshot entry per channel); prints its links. |
| `open-in-browser.mjs` | Opens a link with `?perf` in Chromium and reports the page's own measures, first load and reloads; `--via` goes through the proxy. |
| `load-clients.mjs` | N library clients on one document: time to open, and end-to-end latency of the writers' keystrokes. |
| `latency-proxy.mjs` | A TCP proxy adding a delay each way (no `tc netem`, no root). |
| `typing-in-browser.mjs` | Typing in a long formatted document (phase 11e.3): `--blocks 3000`, `--at start` or `end` (the worst case: everything before the caret parsed); the page's `oc:live` and `oc:live.blocks` per keystroke, formatted and as source, and the time to the next frame. Starts its own server (debug build by default). |
| `server-stats.mjs` | The server's memory, CPU and SQLite size, from `/proc`. |

A run:

```sh
node scripts/perf/profile-document.mjs --out perf-out/profile
BIND_ADDR=127.0.0.1:8080 DATABASE_PATH=perf-out/journal.sqlite3 ../server/target/release/server &
node scripts/perf/seed-document.mjs --from perf-out/profile > perf-out/links.json
node scripts/perf/open-in-browser.mjs --link "$(node -p 'require("./perf-out/links.json").edit')"
```

Start background processes from a script rather than as shell jobs: an interrupted run otherwise leaves a server holding the port, and the next run talks to it.
