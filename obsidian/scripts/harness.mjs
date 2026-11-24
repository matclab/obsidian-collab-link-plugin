// The real Obsidian, for the plugin's end-to-end test and its UI check
// (docs/phase-14-plugin-obsidian.md, decision 10; 14f.3, 14g): the
// library and the plugin built, the plugin copied into a throwaway vault,
// the server and Obsidian (as choice/obsidian/launch.sh, DevTools on port
// 9333) started, each in its own process group — stopped as one, never by
// `pkill -f`. Obsidian runs on an Xvfb display of its own, known, so that
// a second `obsidian <address>` reaches it, as a browser would hand it an
// `obsidian://` address (phase 18m); what Obsidian sends to the system's
// browser goes to a fake `xdg-open`, which notes it.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Waits until `check` gives something truthy, and returns it. */
export async function until(what, check, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(250);
  }
}

/** A display no X server holds. */
function freeDisplay() {
  for (let n = 90 + Math.floor(Math.random() * 100); ; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
  }
}

/** Obsidian's command line, as choice/obsidian/launch.sh has it. */
const OBSIDIAN = [
  "/usr/lib/obsidian/app.asar",
  "--ozone-platform=x11",
  "--no-sandbox",
  "--disable-crashpad-for-testing",
  "--no-zygote",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-dev-shm-usage",
];

/** Obsidian on a throwaway vault, with the plugin enabled, and the server.
 * `preferences` go to the plugin's data.json (a pseudonym: no dialog),
 * `settings` beside them; `port` and `serverEnv` set the server's. */
export async function startObsidian({
  preferences = {},
  settings = {},
  keep = false,
  port: chosenPort,
  serverEnv = {},
} = {}) {
  const run = (cwd, ...args) => {
    const done = spawnSync("npm", ["run", ...args], { cwd, stdio: "inherit" });
    if (done.status !== 0) throw new Error(`npm run ${args.join(" ")} failed`);
  };
  run(join(ROOT, "web"), "build:lib");
  run(join(ROOT, "obsidian"), "build");

  const work = mkdtempSync(join(tmpdir(), "collab-link-e2e-"));
  const vault = join(work, "vault");
  const pluginDir = join(vault, ".obsidian/plugins/collab-link");
  mkdirSync(pluginDir, { recursive: true });
  for (const file of readdirSync(join(ROOT, "obsidian/dist"))) {
    copyFileSync(join(ROOT, "obsidian/dist", file), join(pluginDir, file));
  }
  writeFileSync(
    join(pluginDir, "data.json"),
    JSON.stringify({ ...settings, preferences }),
  );
  // The system's browser, as Obsidian reaches it: a script that notes.
  const bin = join(work, "bin");
  mkdirSync(bin);
  const opened = join(work, "opened.log");
  writeFileSync(
    join(bin, "xdg-open"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`,
  );
  chmodSync(join(bin, "xdg-open"), 0o755);
  const display = freeDisplay();
  // Unix socket paths are limited to 108 bytes: a short runtime directory.
  const runtime = `/tmp/obs-run-${process.getuid()}`;
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  mkdirSync(join(work, "cfg/obsidian"), { recursive: true });
  mkdirSync(join(work, "cache"), { recursive: true });
  writeFileSync(
    join(work, "cfg/obsidian/obsidian.json"),
    JSON.stringify({
      vaults: {
        probevault0000001: { path: vault, ts: 1760000000000, open: true },
      },
      updateDisabled: true,
    }),
  );
  const obsidianEnv = {
    WAYLAND_DISPLAY: "",
    DISPLAY: display,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: join(work, "cfg"),
    XDG_CACHE_HOME: join(work, "cache"),
    PATH: `${bin}:${process.env.PATH}`,
  };

  const port = chosenPort ?? 18000 + Math.floor(Math.random() * 900);
  const server = `http://127.0.0.1:${port}`;
  const children = [];
  const start = (command, env, args = []) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: "ignore",
      detached: true,
    });
    children.push(child);
  };
  let browser;
  const stop = async () => {
    await browser?.close().catch(() => {});
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    if (!keep) rmSync(work, { recursive: true, force: true });
  };
  try {
    start(join(ROOT, "server/target/debug/server"), {
      BIND_ADDR: `127.0.0.1:${port}`,
      DATABASE_PATH: join(work, "journal.sqlite3"),
      ...serverEnv,
    });
    start("Xvfb", {}, [
      display,
      "-screen",
      "0",
      "1440x900x24",
      "-nolisten",
      "tcp",
    ]);
    await until("the display", () =>
      existsSync(`/tmp/.X11-unix/X${display.slice(1)}`),
    );
    start("electron43", obsidianEnv, [
      ...OBSIDIAN,
      "--remote-debugging-port=9333",
    ]);

    const require = createRequire(join(ROOT, "choice/render/package.json"));
    const { chromium } = require("playwright-core");
    const lib = await import(join(ROOT, "web/lib/dist/index.js"));
    browser = await until(
      "Obsidian",
      () => chromium.connectOverCDP("http://localhost:9333"),
      90_000,
    );
    const page = await until("its window", () =>
      browser
        .contexts()[0]
        ?.pages()
        .find((p) => p.url().startsWith("app://")),
    );
    await until("its workspace", () =>
      page.evaluate(() => !!window.app?.workspace?.layoutReady),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    // Obsidian asks whether to trust a new vault's plugins: closed as a
    // user would (a modal taken out of the page keeps its keyboard scope,
    // which takes the focus from the view), then the plugin enabled.
    await sleep(1000);
    await page.evaluate(async () => {
      for (const modal of document.querySelectorAll(".modal-container")) {
        modal
          .querySelector(".modal-close-button, .modal-header-button")
          ?.click();
      }
      await app.plugins.setEnable(true);
      await app.plugins.enablePluginAndSave("collab-link");
    });
    await until("no modal left", () =>
      page.evaluate(() => !document.querySelector(".modal-container")),
    );
    await until("the server", () => lib.createDocument(server));

    const fileText = (path) =>
      existsSync(join(vault, path))
        ? readFileSync(join(vault, path), "utf8")
        : undefined;
    /** Hands Obsidian an address, as the system does: a second process,
     * which gives it to the first and ends (relevé 18a, §3). */
    const openInObsidian = (url) => {
      const done = spawnSync("electron43", [...OBSIDIAN, url], {
        env: { ...process.env, ...obsidianEnv },
        stdio: "ignore",
        timeout: 30_000,
      });
      if (done.status !== 0) {
        throw new Error(`obsidian ${url}: ${done.status ?? done.signal}`);
      }
    };
    /** What Obsidian sent to the system's browser, in order. */
    const sentToBrowser = () =>
      existsSync(opened)
        ? readFileSync(opened, "utf8").split("\n").filter(Boolean)
        : [];
    return {
      page,
      lib,
      server,
      work,
      vault,
      fileText,
      stop,
      openInObsidian,
      sentToBrowser,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
