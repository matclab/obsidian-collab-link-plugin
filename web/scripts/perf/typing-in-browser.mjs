// Typing in a long formatted document, in Chromium with `?perf` (phase
// 11e.3): a page writes a document of `--blocks` blocks of every kind the
// formatting reads, then, reloaded, types 40 keys in it, formatted, as its
// source, formatted again; reports the page's own measures per keystroke —
// `oc:live` (the part on screen formatted) and `oc:live.blocks` (tables
// and formulas: every top-level block parsed, option (a)) — and the time
// to the next frame. `--at end` types at the end of the document, where
// everything before it is parsed: the worst case.
//
//   node scripts/perf/typing-in-browser.mjs [--blocks 3000] [--at start|end]
//     [--server ../server/target/debug/server]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { args } from "./args.mjs";

const options = args({
  blocks: 3000,
  at: "start",
  server: resolve(import.meta.dirname, "../../../server/target/debug/server"),
  chromium: "/usr/bin/chromium",
  playwright: resolve(import.meta.dirname, "../../../choice/render/"),
});
const { chromium } = createRequire(`${options.playwright}/`)("playwright-core");

/** Every kind of block the formatting reads, in turn. */
function longMarkdown(blocks) {
  const kinds = [
    (i) => `## Section ${i}`,
    (i) =>
      `Un paragraphe ${i} avec du **gras**, de l'*italique*, du \`code\` et un [lien](https://example.org/${i}).`,
    (i) => `- point ${i}\n- [ ] tâche ${i}\n  - sous-point`,
    (i) => `> Une citation ${i}\n> sur deux lignes.`,
    (i) => `| a | b |\n|---|---|\n| ${i} | $x_{${i}}$ |`,
    (i) => `$$\n\\sum_{k=0}^{${i}} k\n$$`,
    (i) => `\`\`\`\nconst x = ${i};\n\`\`\``,
  ];
  return Array.from({ length: blocks }, (_, i) => kinds[i % kinds.length](i));
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;

// Here, Chromium loads pages only as one process (docs: browser tooling).
const scratch = mkdtempSync(join(tmpdir(), "oc-typing-"));
process.env.XDG_CONFIG_HOME ??= join(scratch, "config");
process.env.XDG_CACHE_HOME ??= join(scratch, "cache");
const port = 18000 + Math.floor(Math.random() * 900);
const server = spawn(options.server, [], {
  env: { ...process.env, BIND_ADDR: `127.0.0.1:${port}`, DATABASE_PATH: join(scratch, "journal.sqlite3") },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    await new Promise((done) => setTimeout(done, 100));
  }
}
const browser = await chromium.launch({
  executablePath: options.chromium,
  args: ["--single-process", "--disable-crashpad-for-testing"],
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem("obsidian-collab:pseudonym", "perf"));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // `?new` creates a document; `/` is the home (phase 18, decision 3).
  await page.goto(`${base}/?new`);
  await page.waitForSelector(".cm-content");
  const url = new URL(page.url());
  await page.click(".cm-content");
  // By a thousand blocks: one insertion of the whole text takes too long.
  const blocks = longMarkdown(options.blocks);
  for (let i = 0; i < blocks.length; i += 1000) {
    await page.keyboard.insertText(`${i ? "\n\n" : ""}${blocks.slice(i, i + 1000).join("\n\n")}`);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3000);
  url.searchParams.set("perf", "");
  for (const mode of ["formatted", "source", "formatted"]) {
    await page.goto(url.toString());
    await page.waitForSelector(".cm-content");
    await page.waitForTimeout(3000);
    // One of three views (ADR-0064, AC8): the one wanted, pressed.
    const wanted = page.locator(mode === "source" ? ".source-toggle" : ".formatted-toggle");
    if ((await wanted.getAttribute("aria-pressed")) !== "true") {
      await wanted.click();
      await page.waitForTimeout(500);
    }
    await page.evaluate(() => performance.clearMeasures());
    await page.click(".cm-content");
    if (options.at === "end") {
      await page.keyboard.press("Control+End");
      await page.waitForTimeout(3000);
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowUp");
    } else {
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("End");
    const frames = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.type("k");
      frames.push(
        await page.evaluate(
          () =>
            new Promise((done) => {
              const start = performance.now();
              requestAnimationFrame(() => setTimeout(() => done(performance.now() - start), 0));
            }),
        ),
      );
    }
    const measured = await page.evaluate(() => {
      const of = (name) => performance.getEntriesByName(name).map((entry) => entry.duration);
      return { live: of("oc:live"), blocks: of("oc:live.blocks") };
    });
    const ms = (xs) => `median ${median(xs).toFixed(2)} ms, p95 ${p95(xs).toFixed(2)} ms`;
    console.log(
      `${mode.padEnd(9)} oc:live ${ms(measured.live)} | oc:live.blocks ${ms(measured.blocks)} | next frame ${ms(frames)}`,
    );
  }
} finally {
  await browser.close();
  server.kill();
  if (errors.length > 0) console.log("page errors:", errors);
}
