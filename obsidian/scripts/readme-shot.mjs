// The README's picture of the plugin (README.md, obsidian/README.md): the
// annotated document of `web/scripts/ui/readme-shot.mjs`, in Obsidian —
// Ada writes and annotates in the plugin's view, Grace comments from a
// browser, Ada replies. Taken again whenever what it shows changes
// (AGENTS.md §5, "display"). The real Obsidian under Xvfb, against the
// real server (`harness.mjs`).
//
//   (cd ../web && npm run build) && (cd ../server && cargo build -p app)
//   node scripts/readme-shot.mjs [--out ../docs/images/obsidian-annotated.png]
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ROOT, sleep, startObsidian } from "./harness.mjs";

const options = { out: join(ROOT, "docs/images/obsidian-annotated.png") };
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i] !== "--out") {
    throw new Error(`unknown option ${process.argv[i]}`);
  }
  options.out = resolve(process.argv[i + 1] ?? "");
}
const { TEXT } = await import(join(ROOT, "web/scripts/ui/readme-text.mjs"));

// Obsidian, and so the plugin, in English, whatever this machine's
// language: Electron reads it from the environment it inherits.
Object.assign(process.env, {
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LANGUAGE: "en",
});
const port = 18000 + Math.floor(Math.random() * 900);
const { page, lib, server, stop } = await startObsidian({
  preferences: { "obsidian-collab:pseudonym": "Ada" },
  settings: { server: `http://127.0.0.1:${port}` },
  port,
});
const require = createRequire(join(ROOT, "choice/render/package.json"));
const { chromium } = require("playwright-core");
let browser;
try {
  const created = await lib.createDocument(server);
  const links = await lib.documentLinks(
    `${server}/`,
    created.documentId,
    created.keyMaterial,
    created.editSecret,
  );
  await page.evaluate(() => app.changeTheme("moonstone"));
  const VIEW = ".workspace-leaf.mod-active .collab-link-view";
  const at = (selector) => `${VIEW} ${selector}`;

  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:open-link"),
  );
  await page.fill(".modal input.collab-link-link", links.edit);
  await page.click(".modal button.mod-cta");
  await page.waitForSelector(at(".cm-content"), {
    state: "attached",
    timeout: 30_000,
  });
  await sleep(800);
  await page.click(at(".cm-content"));
  await page.keyboard.insertText(TEXT);
  await sleep(500);

  async function annotate(word, which, text) {
    const point = await page.evaluate(
      ([view, w]) => {
        for (const line of document.querySelectorAll(`${view} .cm-line`)) {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent.indexOf(w);
            if (i < 0) continue;
            n.parentElement?.scrollIntoView({ block: "center" });
            const range = document.createRange();
            range.setStart(n, i);
            range.setEnd(n, i + w.length);
            const box = range.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          }
        }
        throw new Error(`no ${w}`);
      },
      [VIEW, word],
    );
    await page.mouse.dblclick(point.x, point.y);
    await sleep(200);
    await page.locator(at(".selection-toolbar > button")).nth(which).click();
    await page.fill(
      at(which === 2 ? ".composer-note" : ".composer-text"),
      text,
    );
    await page.locator(at(".selection-toolbar .primary")).click();
    await sleep(300);
  }
  await annotate("week", 1, "two weeks");
  await annotate("left", 2, "Not needed here.");

  // Grace, in a browser.
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--single-process", "--disable-crashpad-for-testing"],
  });
  const context = await browser.newContext({ locale: "en-US" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("obsidian-collab:pseudonym", "Grace");
      localStorage.setItem("obsidian-collab:sign-to-name", "without");
    } catch {}
  });
  const grace = await context.newPage();
  await grace.goto(links.edit);
  await grace.waitForSelector(".cm-content", { timeout: 15_000 });
  await grace.waitForTimeout(800);
  const word = await grace.evaluate(() => {
    for (const line of document.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent.indexOf("fuzzing");
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 7);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    throw new Error("no fuzzing");
  });
  await grace.mouse.dblclick(word.x, word.y);
  await grace.waitForTimeout(200);
  await grace.locator(".selection-toolbar > button").nth(0).click();
  await grace.fill(
    ".composer-text",
    "Which targets? A link to the security note would help.",
  );
  await grace.locator(".selection-toolbar .primary").click();
  await grace.waitForTimeout(300);
  await grace.click(".cm-content");
  await grace.keyboard.press("Control+End");
  await sleep(1500);

  // Ada answers in the thread, in Obsidian.
  const card = page.locator(at(".annotations-list .annotation-item"), {
    hasText: "Which targets?",
  });
  await card.click();
  await page.locator(at(".annotation-item.active .reply-open")).click();
  await page.fill(
    at(".annotation-item.active .reply-text"),
    "All four, 30 minutes each: see the fuzzing log.",
  );
  await page.keyboard.press("Control+Enter");
  await sleep(800);
  await page.evaluate(() =>
    document
      .querySelector(".workspace-leaf.mod-active .cm-scroller")
      ?.scrollTo(0, 0),
  );
  await card.click();
  // The note, in its folder.
  await page.evaluate(() =>
    app.commands.executeCommandById("file-explorer:reveal-active-file"),
  );
  await sleep(1500);
  mkdirSync(dirname(options.out), { recursive: true });
  await page.screenshot({ path: options.out });
  console.log(`written: ${options.out}`);
} finally {
  await browser?.close().catch(() => {});
  await stop();
}
