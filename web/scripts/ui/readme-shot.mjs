// The README's picture of the page (README.md, obsidian/README.md): an
// annotated document, as two people see it in a browser — Ada writes and
// annotates, Grace replies. Taken again whenever what it shows changes
// (AGENTS.md §5, "display"). Against the real server, in Chromium.
//
//   npm run build && (cd ../server && cargo build -p app)
//   node scripts/ui/readme-shot.mjs [--out ../docs/images/page-annotated.png]
//     [--server path] [--chromium /usr/bin/chromium]
//     [--playwright path/to/playwright-core]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEXT } from "./readme-text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const options = {
  out: resolve(web, "../docs/images/page-annotated.png"),
  server: resolve(web, "../server/target/debug/server"),
  chromium: "/usr/bin/chromium",
  playwright: resolve(web, "../choice/render/node_modules/playwright-core"),
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (!key || !(key in options)) throw new Error(`unknown option ${process.argv[i]}`);
  options[key] = resolve(process.argv[i + 1] ?? "");
}
const { chromium } = await import(join(options.playwright, "index.mjs"));


const data = mkdtempSync(join(tmpdir(), "oc-readme-shot-"));
const port = 18000 + Math.floor(Math.random() * 900);
const server = spawn(options.server, [], {
  env: { ...process.env, BIND_ADDR: `127.0.0.1:${port}`, DATABASE_PATH: join(data, "journal.sqlite3") },
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

// Chromium only runs here with --single-process: a browser per person.
const browsers = [];
async function person(name) {
  const browser = await chromium.launch({
    executablePath: options.chromium,
    args: ["--single-process", "--disable-crashpad-for-testing"],
  });
  browsers.push(browser);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    colorScheme: "light",
  });
  await context.addInitScript((name) => {
    try {
      localStorage.setItem("obsidian-collab:pseudonym", name);
      localStorage.setItem("obsidian-collab:sign-to-name", "without");
    } catch {}
  }, name);
  return context.newPage();
}

async function open(page, url) {
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(800);
}

/** A double click on `word`. */
async function selectWord(page, word) {
  const at = await page.evaluate((w) => {
    for (const line of document.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent.indexOf(w);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    throw new Error(`no ${w}`);
  }, word);
  await page.mouse.click(at.x, at.y, { clickCount: 2 });
  await page.waitForTimeout(150);
}

/** Through the toolbar: comment (0), suggest (1), delete (2). */
async function annotate(page, word, which, text) {
  await selectWord(page, word);
  await page.locator(".selection-toolbar > button").nth(which).click();
  await page.fill(which === 2 ? ".composer-note" : ".composer-text", text);
  await page.locator(".selection-toolbar .primary").click();
  await page.waitForTimeout(300);
}

try {
  const ada = await person("Ada");
  await open(ada, `${base}/?new`);
  await ada.click(".cm-content");
  await ada.keyboard.insertText(TEXT);
  await annotate(ada, "week", 1, "two weeks");
  await annotate(ada, "left", 2, "Not needed here.");
  await ada.click(".share-button");
  const edit = await ada.evaluate(() => document.querySelector("input.share-edit")?.value);
  await ada.keyboard.press("Escape");
  if (!edit) throw new Error("no edit link");

  const grace = await person("Grace");
  await open(grace, edit);
  await annotate(grace, "fuzzing", 0, "Which targets? A link to the security note would help.");
  // Her caret out of the text Ada looks at.
  await grace.click(".cm-content");
  await grace.keyboard.press("Control+End");
  await ada.waitForTimeout(1000);
  // Ada answers in the thread.
  await ada.locator(".annotations-list .annotation-item", { hasText: "Which targets?" }).click();
  await ada.locator(".annotation-item.active .reply-open").click();
  await ada.fill(".annotation-item.active .reply-text", "All four, 30 minutes each: see the fuzzing log.");
  await ada.keyboard.press("Control+Enter");
  await ada.waitForTimeout(800);
  await ada.click(".cm-content");
  await ada.keyboard.press("Control+End");
  await ada.waitForTimeout(500);
  // What a first visit shows, once: dismissed.
  for (const name of ["Got it", "Not now"]) {
    const button = ada.getByRole("button", { name, exact: true });
    if (await button.count()) await button.first().click();
  }
  await ada.locator(".annotations-list .annotation-item", { hasText: "Which targets?" }).click();
  await ada.waitForTimeout(800);
  mkdirSync(dirname(options.out), { recursive: true });
  await ada.screenshot({ path: options.out });
  console.log(`written: ${options.out}`);
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
