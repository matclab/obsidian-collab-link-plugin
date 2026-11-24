// Checks the page in a real browser (phase 10g): accessibility with axe-core
// (no serious or critical violation) and no horizontal scroll, for each
// role, each mode (side by side on the wide screen; the formatted text, with
// each of its widgets, and the source; the formatting toolbar's menu, the
// toolbar hidden, the / menu, the writing help), two widths and both
// themes, plus the dialogs; and what a screen reader gets of the formatted
// text. Against the real server, on a document annotated through the
// selection toolbar.
// Not in `npm test` (jsdom computes neither layout nor contrast).
//
//   npm run build && (cd ../server && cargo build)
//   node scripts/ui/check.mjs [--locale fr-FR] [--shots dir] [--server path]
//     [--chromium /usr/bin/chromium] [--playwright path/to/playwright-core]
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../..");
const options = {
  locale: "fr-FR",
  shots: "",
  server: resolve(web, "../server/target/debug/server"),
  chromium: "/usr/bin/chromium",
  playwright: resolve(web, "../choice/render/node_modules/playwright-core"),
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (!key || !(key in options)) throw new Error(`unknown option ${process.argv[i]}`);
  options[key] = process.argv[i + 1] ?? "";
}
const { chromium } = await import(join(options.playwright, "index.mjs"));
const axe = readFileSync(join(web, "node_modules/axe-core/axe.min.js"), "utf8");

const TEXT =
  // A note's properties (phase 14, decision 19).
  "---\ntags: [réunion, projet]\n---\n# Compte rendu\n\n## Décisions\n\nLa phase 9 est terminée, et le fuzzing n'a trouvé aucun plantage restant.\n\nNous publierons la version 1.0 à la fin du mois, après une semaine de tests.\n\n- Rendre l'interface bilingue.\n- Choisir une police de lecture.\n\n| Tâche | Qui |\n|---|---|\n| Prototype | Mathieu |\n\n" +
  // Each widget of the formatted text (phase 11e.2).
  "- [ ] Relire ==le texte==.\n- [x] Écrire le plan.\n\n1. [ ] Une tâche numérotée.\n\n> Une citation, avec un [lien](https://example.org).\n\n" +
  // Obsidian's callouts (phase 15): a title, a folded one with its default.
  "> [!warning] Attention, un *titre*\n> Le contenu du callout.\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n>\n> ```\n> code\n> ```\n\n> [!tip]-\n> Replié dans l'aperçu.\n\n" +
  // Highlights, each color (ADR-0044): the text read on each tint.
  "Un ==surlignage==, ==🔴rouge==, ==🟠orange==, ==🟡jaune==, ==🟢vert==, ==🔵bleu== et ==🟣violet==.\n\n" +
  // Obsidian's [[…]] (phase 19): to a heading, a link; to a note, set apart.
  "Vers [[#Décisions]], [[#Décisions|les décisions]] et une note non partagée : [[Brouillon]].\n\n" +
  "Une formule $E = mc^2$ et un bloc :\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n" +
  "![Un carré rouge](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==)\n\n" +
  // A remote image (ADR-0055): its case and the banner, not granted.
  "Une carte distante : ![Une carte](https://img.example/carte.png)\n\n" +
  // A wide diagram, drawn by Pele in the preview (ADR-0042).
  "```mermaid\nflowchart LR\n  A[Rédaction] --> B{Relecture} --> C[Décision] --> D[Publication] --> E[Archivage]\n```\n\n" +
  "```\nconst x = 1;\n```\n";

// An annotation's text in Markdown (ADR-0047): a list, a highlight, a
// link, inline code, and a code block whose line is wider than any card.
const RICH_COMMENT =
  "Détail technique ?\n\n- voir la **note de sécurité**\n- ==🟡à vérifier== avec `run.sh`\n\n> une citation du texte\n\n[Le guide](https://rust-fuzz.github.io/book/)\n\n```sh\nserver/fuzz/run.sh 1800 relay parse_client_message decode_frame parse_create_document\n```";

const data = mkdtempSync(join(tmpdir(), "oc-ui-check-"));
const port = 18000 + Math.floor(Math.random() * 900);
// The gateway (18i.2), played by the browser's own routes (`fakeGateway`):
// the page's policy names it, as a deployment's would.
const GATEWAY = "http://gateway.test";
// Its attestation key (analysis 18k): the server's pages trust it.
const attestationKey = generateKeyPairSync("ed25519");
const attestationPublic = attestationKey.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(12);
const attestationFingerprint = createHash("sha256").update(attestationPublic).digest("hex");

/** Deterministic CBOR of docs/protocol/06-identity.md, §6.2: what an
 * attestation's message and envelope are. */
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 2 ** 8) return Buffer.from([(major << 5) | 24, n]);
    if (n < 2 ** 16) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const pairs = Object.entries(value)
    .map(([k, v]) => [cbor(k), cbor(v)])
    .sort(([a], [b]) => Buffer.compare(a, b));
  return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
}

/** An attestation of `key` for the test's account, valid 30 days. */
function attestationOf(key) {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const msg = cbor({
    ctx: "oc-attestation/v1",
    issuer: "https://idp.example",
    sub: "u-1",
    name: "Mathieu Clabaut",
    email: "mathieu@example.org",
    key,
    issuedAt,
    expiresAt: issuedAt + 30 * 24 * 3600,
  });
  return cbor({ key: attestationPublic, msg, sig: sign(null, msg, attestationKey.privateKey) });
}
const server = spawn(options.server, [], {
  env: {
    ...process.env,
    BIND_ADDR: `127.0.0.1:${port}`,
    DATABASE_PATH: join(data, "journal.sqlite3"),
    GATEWAY_URL: GATEWAY,
    GATEWAY_ATTESTATION_KEYS: attestationFingerprint,
    // Notifications by Web Push (ADR-0060): this device offered too.
    PUSH_CONTACT: "mailto:ui@example.org",
  },
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
if (options.shots) mkdirSync(options.shots, { recursive: true });

// Chromium only runs here with --single-process, which holds one context:
// a browser per context.
const browsers = [];
const problems = [];
/** Views with a key brought forward (ADR-0051 §4). */
let keysChecked = 0;
let checked = 0;

/** The gateway's answers (docs/protocol/06-identity.md, §6.7), for the
 * pages of `context`: health, the sign-in window, which goes straight
 * back to the server's `/auth-return` — once `held` lets it —, the
 * exchange, logout. CORS for the server's origin, as the gateway's. */
/** The account's keyring (KR-39), shared by every browser: one account;
 * and its registered key (ID-29). */
const accountKeyring = { version: 0, blob: Buffer.alloc(0) };
const account = { key: undefined, notRecent: false };
/** Who signs in (18o.2: another person, on the same browser, later). */
const person = { name: "Mathieu Clabaut", email: "mathieu@example.org", sub: "u-1" };

function fakeGateway(context) {
  const gateway = { held: undefined };
  const cors = {
    "access-control-allow-origin": base,
    "access-control-allow-methods": "GET, POST, PUT",
    "access-control-allow-headers": "Authorization, Content-Type, If-Match",
  };
  const code = "C".repeat(42) + "A";
  context.route(`${GATEWAY}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    switch (url.pathname) {
      case "/accounts/health":
        return route.fulfill({ status: 200, headers: cors, json: {} });
      case "/accounts/login":
        await gateway.held;
        return route.fulfill({
          status: 303,
          headers: { location: `${base}/auth-return#code=${code}&request=${url.searchParams.get("request")}` },
        });
      case "/accounts/session":
        return route.fulfill({
          status: 200,
          headers: cors,
          json: {
            token: "T".repeat(42) + "A",
            expires_at: 0,
            name: person.name,
            email: person.email,
            issuer: "https://idp.example",
            sub: person.sub,
          },
        });
      case "/accounts/logout":
        return route.fulfill({ status: 204, headers: cors });
      case "/accounts/me":
        return route.fulfill({
          status: 200,
          headers: cors,
          json: {
            name: person.name,
            email: person.email,
            expires_at: 0,
            issuer: "https://idp.example",
            sub: person.sub,
            key: account.key ? account.key.toString("base64url") : null,
          },
        });
      case "/accounts/key":
        // A sign-in not recent enough (18o.3): the identity to confirm.
        if (account.notRecent) return route.fulfill({ status: 403, headers: cors });
        // Registered as asked: the page signs in recently for it.
        account.key = Buffer.from(JSON.parse(request.postData() ?? "{}").key ?? "", "base64url");
        return route.fulfill({ status: 204, headers: cors });
      case "/accounts/attestation": {
        const key = Buffer.from(JSON.parse(request.postData() ?? "{}").key ?? "", "base64url");
        if (!account.key || !account.key.equals(key)) return route.fulfill({ status: 409, headers: cors });
        return route.fulfill({ status: 200, headers: cors, json: { attestation: attestationOf(key).toString("base64url") } });
      }
      case "/accounts/keyring": {
        const tagged = (version) => ({ ...cors, etag: `"${version}"`, "access-control-expose-headers": "ETag" });
        if (request.method() === "GET") {
          return route.fulfill({ status: 200, headers: tagged(accountKeyring.version), body: accountKeyring.blob });
        }
        if (request.headers()["if-match"] !== `"${accountKeyring.version}"`) {
          return route.fulfill({ status: 412, headers: tagged(accountKeyring.version) });
        }
        accountKeyring.version += 1;
        accountKeyring.blob = request.postDataBuffer() ?? Buffer.alloc(0);
        return route.fulfill({ status: 204, headers: tagged(accountKeyring.version) });
      }
      default:
        return route.fulfill({ status: 404, headers: cors });
    }
  });
  return gateway;
}

/** Signs in from the home, the gateway's window let through at once. If
 * the sign-in doesn't end, the error says where the window went: the
 * window has been seen, rarely, ending on Chromium's error page. */
async function signInThrough(page) {
  await page.waitForSelector(".home-sign-in:not([disabled])", { timeout: 15000 });
  const popup = page.waitForEvent("popup");
  await page.click(".home-sign-in");
  const window = await popup;
  const trail = [window.url()];
  window.on("framenavigated", (frame) => trail.push(frame.url()));
  window.on("requestfailed", (request) => trail.push(`failed ${request.url()}: ${request.failure()?.errorText}`));
  try {
    await page.waitForSelector(".home-sign-out", { timeout: 15000 });
  } catch (error) {
    throw new Error(`no sign-in; the window went: ${trail.join(" → ")}`, { cause: error });
  }
}

/** A page in a browser of its own. `csp`: the page's policy applies —
 * else it is bypassed, only to inject axe-core. */
async function newPage(colorScheme, { csp = false, ask = false } = {}) {
  const browser = await chromium.launch({
    executablePath: options.chromium,
    args: ["--single-process", "--disable-crashpad-for-testing"],
  });
  browsers.push(browser);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: options.locale,
    colorScheme,
    bypassCSP: !csp,
  });
  context.gateway = fakeGateway(context);
  // A name already kept: no dialog; nor that of decision 20, asked once
  // where it is looked at (below). Not on about:blank, which has none.
  await context.addInitScript((ask) => {
    try {
      localStorage.setItem("obsidian-collab:pseudonym", "Mathieu");
      if (!ask) localStorage.setItem("obsidian-collab:sign-to-name", "without");
    } catch {}
  }, ask);
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  // What CodeMirror catches in a listener or a plugin, it only logs: the
  // outline column stood still on such an error, in Chromium only.
  page.on("console", (message) => {
    if (message.type() === "error" && /crashed/.test(message.text()))
      problems.push(`console: ${message.text().split("\n")[0]}`);
  });
  return page;
}

/** The view chosen in Write (ADR-0064, AC8), to come back to it: its
 * button's class. */
function viewShown(page) {
  return page.evaluate(() =>
    [...(document.querySelector(".view-choice [aria-pressed='true']")?.classList ?? [])].find((c) =>
      c.endsWith("-toggle"),
    ),
  );
}

async function viewBack(page, toggle) {
  if (toggle) await page.click(`.view-choice .${toggle}`);
  await page.waitForTimeout(300);
}

async function open(page, url) {
  await page.goto("about:blank");
  await page.goto(url);
  await page.waitForSelector(".cm-content", { state: "attached", timeout: 15000 });
  await page.waitForTimeout(500);
}

/** A double click on `word` (`clicks`: 3, a triple one), where it is
 * before the first press. */
async function selectWord(page, word, clicks = 2) {
  const at = await page.evaluate((w) => {
    for (const line of document.querySelectorAll(".cm-line")) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent.indexOf(w);
        if (i < 0) continue;
        // In sight first: the text may be longer than the window.
        n.parentElement?.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + w.length);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    throw new Error(`no ${w}`);
  }, word);
  await page.mouse.click(at.x, at.y, { clickCount: clicks });
  await page.waitForTimeout(150);
}

/** Through the toolbar, by position: comment (its text), suggest (the
 * replacement), delete (why). */
async function annotate(page, word, which, text) {
  await selectWord(page, word);
  await page.locator(".selection-toolbar > button").nth(which).click();
  await page.fill(which === 2 ? ".composer-note" : ".composer-text", text);
  await page.locator(".selection-toolbar .primary").click();
  await page.waitForTimeout(250);
}

/** Replies to the first open card (ADR-0035), through its field. */
async function reply(page, text) {
  await page.locator(".annotations-list .annotation-item").first().click();
  await page.locator(".annotation-item.active .reply-open").click();
  await page.fill(".annotation-item.active .reply-text", text);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
}

/** The invitation to be notified, whole in the window wherever I wrote
 * (phase 34j, NI4). */
async function inSight(page, at) {
  const box = await page.locator(".alerts-invite").boundingBox();
  const size = page.viewportSize();
  if (!box || !size || box.y < 0 || box.y + box.height > size.height + 1) {
    problems.push(`${at}: the invitation is out of sight`);
  }
}

/** The contrast between the editor's caret and the page (WCAG ratio):
 * axe-core doesn't look at a caret, invisible once on the dark theme. */
async function caretContrast(page) {
  return page.evaluate(() => {
    const rgb = (color) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = ([r, g, b]) => {
      const c = [r, g, b].map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const content = document.querySelector(".cm-content");
    const editor = document.querySelector(".cm-editor");
    if (!content || !editor) return 0;
    const caret = luminance(rgb(getComputedStyle(content).caretColor));
    const paper = luminance(rgb(getComputedStyle(editor).backgroundColor));
    return (Math.max(caret, paper) + 0.05) / (Math.min(caret, paper) + 0.05);
  });
}

/** What a screen reader gets of the formatted text (phase 11e.2): no
 * hidden markup in its text, the headings as headings, the quote and the
 * link said, each widget named (axe-core checks the names it knows). */
async function readable(page, label) {
  const content = page.locator(".cm-content");
  if (!(await content.isVisible())) return;
  const text = (await content.textContent()) ?? "";
  // A code block's fences stay, dimmed: a plugin cannot take a line away
  // (analysis 11a.1).
  for (const markup of ["**", "](", "# ", "[ ]", "$$"]) {
    if (text.includes(markup)) problems.push(`${label}: "${markup}" read in the formatted text`);
  }
  // CodeMirror draws only what is near the viewport: the text's top, then
  // its bottom, scrolled to.
  let tree = await content.ariaSnapshot();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  tree += await content.ariaSnapshot();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  for (const said of [
    'heading "Compte rendu" [level=1]',
    'heading "Décisions" [level=2]',
    "group",
    'link "lien"',
    'checkbox "',
    'img "Un carré rouge"',
    "math:",
    "table:",
  ]) {
    if (!tree.includes(said)) problems.push(`${label}: no ${said} for a screen reader`);
  }
}

async function check(page, label) {
  checked++;
  // A size just set: the view's widths are read by a ResizeObserver,
  // after layout. Two frames, and what it changed is laid out.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) problems.push(`${label}: ${overflow}px of horizontal scroll`);
  await page.evaluate(axe);
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
  });
  for (const violation of violations) problems.push(`${label}: ${violation}`);
  if (options.shots) {
    await page.screenshot({ path: join(options.shots, `${label.replace(/[^\w-]+/g, "-")}.png`) });
  }
}

try {
  // The document, made by an editor.
  const page = await newPage("light");
  await open(page, `${base}/?new`);
  await page.click(".cm-content");
  await page.keyboard.insertText(TEXT);
  await annotate(page, "fuzzing", 0, RICH_COMMENT);
  await annotate(page, "semaine", 1, "deux semaines");
  await annotate(page, "restant", 2, "Inutile ici.");
  // A thread, one reply long enough to wrap on a narrow screen.
  await reply(page, "Pourquoi ?");
  await reply(
    page,
    "Parce que le fuzzing est déjà décrit dans la note de sécurité, avec ses cibles et la durée de chaque campagne ; ici, il suffit d'un renvoi.",
  );
  // In a callout folded in the preview (phase 15): its margin, its card,
  // Review.
  await annotate(page, "Replié", 0, "Dans un callout.");
  // On a plain quote's text, grey: under the comment's tint, it must
  // still read.
  await annotate(page, "citation", 0, "Sur une citation.");
  // Closed, and its passage still there; another whose passage is
  // deleted (ADR-0052): « Closes », « Texte supprimé », the text then.
  await page.locator(".annotations-list .annotation-item", { hasText: "Sur une citation." }).click();
  await page.locator(".annotation-item.active .action-resolve").click();
  await page.waitForTimeout(500);
  await annotate(page, "police", 0, "Laquelle ?");
  await page.click(".share-button");
  const links = await page.evaluate(() =>
    Object.fromEntries(
      ["read", "suggest", "edit"].map((role) => [role, document.querySelector(`input.share-${role}`)?.value]),
    ),
  );
  await page.keyboard.press("Escape");
  await page.context().browser()?.close();
  // Its passage deleted by another editor: a change of its own, later
  // than the one that typed it (ADR-0052, TA2).
  {
    const other = await newPage("light");
    await open(other, links.edit);
    await selectWord(other, "police");
    await other.keyboard.press("Backspace");
    await other.waitForTimeout(800);
    await other.context().browser()?.close();
  }

  // A click on a mark makes its annotation active at once, also where the
  // press reveals the line's markup and moves the text under the pointer;
  // a drag from it, selecting, doesn't. jsdom moves nothing.
  {
    const tab = await newPage("light");
    await open(tab, `${base}/?new`);
    await tab.click(".cm-content");
    await tab.keyboard.insertText("Avec un [lien](https://example.org) et une cible.\n\nUne ligne simple.");
    for (const [word, text] of [
      ["cible", "Sur la cible."],
      ["simple", "Sur la ligne."],
    ]) {
      await annotate(tab, word, 0, text);
    }
    const activeCard = () => tab.locator(".annotation-item.active", { hasText: "Sur la cible." }).count();
    const mark = (word) => tab.locator("[data-ann]", { hasText: word }).boundingBox();
    /** The other annotation made active, by a click on its plain line:
     * the caret there, the link's markup hidden. */
    const elsewhere = async () => {
      const other = await mark("simple");
      if (other) await tab.mouse.click(other.x + other.width / 2, other.y + other.height / 2);
      await tab.waitForTimeout(250);
      if (await activeCard()) problems.push("a click on a plain line's mark didn't make its annotation active");
      const box = await mark("cible");
      if (!box) throw new Error("no mark on « cible »");
      return box;
    };
    let box = await elsewhere();
    await tab.mouse.move(box.x + 4, box.y + box.height / 2);
    await tab.mouse.down();
    await tab.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 4 });
    await tab.mouse.up();
    await tab.waitForTimeout(250);
    if (await activeCard()) problems.push("a drag from a mark made its annotation active");
    box = await elsewhere();
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await tab.waitForTimeout(250);
    if (!(await activeCard())) problems.push("one click on a mark in a line with a link didn't make its annotation active");
    // A double click, a triple one, where the first press reveals the
    // line's markup: the word, the line that were under the pointer, not
    // what moved there.
    for (const [clicks, expected] of [
      [2, "une"],
      [3, "Avec un [lien](https://example.org) et une cible."],
    ]) {
      // Not the active one's line, always revealed (phase 11e).
      await elsewhere();
      await selectWord(tab, "une", clicks);
      const selected = (await tab.evaluate(() => getSelection()?.toString() ?? "")).trim();
      if (selected !== expected) problems.push(`${clicks} clicks on « une » in a line with a link selected « ${selected} »`);
    }
    await tab.context().browser()?.close();
  }

  // Signing in under the page's own policy (ADR-0041): a real click opens
  // the window; the gateway reached because the policy names it, and only
  // it; the return through /auth-return and BroadcastChannel.
  {
    const tab = await newPage("light", { csp: true });
    const response = await tab.goto(`${base}/`);
    const policy = response?.headers()["content-security-policy"] ?? "";
    if (!policy.includes(`connect-src 'self' ${GATEWAY};`)) {
      problems.push(`the page's policy doesn't name the gateway: ${policy}`);
    }
    await tab.waitForSelector(".home-sign-in:not([disabled])", { timeout: 15000 });
    const popup = tab.waitForEvent("popup");
    await tab.click(".home-sign-in");
    await popup;
    try {
      await tab.waitForSelector(".home-sign-out", { timeout: 15000 });
    } catch {
      problems.push("signing in under the page's policy didn't end signed in");
    }
    // Another origin answers: only the policy can refuse it.
    await tab.context().route("http://elsewhere.test/**", (route) =>
      route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "x" }),
    );
    const elsewhere = await tab.evaluate(() =>
      fetch("http://elsewhere.test/").then(
        () => "reached",
        () => "refused",
      ),
    );
    if (elsewhere !== "refused") problems.push("the page's policy let it reach another origin");
    await tab.context().browser()?.close();
  }

  // A remote image under the page's own policy (ADR-0055 §9): nothing
  // requested before the reader's grant; its case in the editor and the
  // preview, each theme and width; granted, loaded, without a referrer,
  // its domain under it, the policy refusing nothing.
  {
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const scheme of ["light", "dark"]) {
      const tab = await newPage(scheme, { csp: true });
      const asked = [];
      await tab.context().route("https://img.example/**", (route) => {
        asked.push(route.request().headers().referer ?? "");
        return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      });
      const refused = [];
      tab.on("console", (message) => {
        if (/Content Security Policy/i.test(message.text())) refused.push(message.text());
      });
      for (const width of [1440, 390]) {
        await tab.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        for (const [role, box] of [
          ["edit", ".cm-live-remote-image-case"],
          ["read", ".remote-image-case"],
        ]) {
          await open(tab, links[role]);
          const at = `${scheme}-${role}-${width}-remote-image`;
          // The editor draws only lines near the screen: the end of the
          // text brought into view, the caret there, not on the image's.
          if (role === "edit") {
            await tab.locator(".cm-content").click({ position: { x: 20, y: 20 } });
            await tab.keyboard.press("Control+End");
            await tab.waitForTimeout(300);
          }
          const found = tab.locator(box).first();
          try {
            await found.waitFor({ state: "attached", timeout: 5000 });
            await found.scrollIntoViewIfNeeded();
            await tab.waitForTimeout(200);
            await check(tab, at);
          } catch {
            problems.push(`${at}: no case`);
          }
        }
      }
      if (asked.length > 0) problems.push(`${scheme}: a remote image requested before the reader's grant`);
      // Granted from the banner, in the reader's preview.
      await tab.setViewportSize({ width: 1440, height: 900 });
      await open(tab, links.read);
      await tab.click(".remote-images-banner button");
      try {
        await tab.waitForFunction(
          () => (document.querySelector(".remote-image-shown img")?.naturalWidth ?? 0) > 0,
          undefined,
          { timeout: 10000 },
        );
        await tab.locator(".remote-image-shown").scrollIntoViewIfNeeded();
        await tab.waitForTimeout(200);
      } catch {
        problems.push(`${scheme}: a remote image granted didn't load under the page's policy`);
      }
      await check(tab, `${scheme}-read-1440-remote-image-granted`);
      if (asked.length === 0) problems.push(`${scheme}: a remote image granted was never requested`);
      if (asked.some((referer) => referer !== "")) {
        problems.push(`${scheme}: a remote image requested with a referrer: ${asked.join(", ")}`);
      }
      for (const message of refused) problems.push(`${scheme}: the page's policy refused: ${message}`);
      await tab.context().browser()?.close();
    }
  }

  for (const scheme of ["light", "dark"]) {
    const viewer = await newPage(scheme);
    // The home (phase 18): no list yet, then one kept, its key shown once;
    // the documents opened below fill it.
    for (const width of [1440, 390]) {
      await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await viewer.goto(`${base}/`);
      await viewer.waitForSelector(".home", { timeout: 15000 });
      if (await viewer.locator(".home-keep").isVisible()) {
        await check(viewer, `${scheme}-home-empty-${width}`);
        if (width === 390) {
          await viewer.click(".home-keep");
          await viewer.waitForSelector(".home-key", { timeout: 15000 });
          await check(viewer, `${scheme}-home-key-${width}`);
          await viewer.click(".home-kept");
        }
      }
    }
    for (const role of ["edit", "suggest", "read"]) {
      for (const width of [1440, 390]) {
        await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await open(viewer, links[role]);
        const at = `${scheme}-${role}-${width}`;
        const modes = viewer.locator(".modes button");
        await check(viewer, `${at}-write`);
        await readable(viewer, `${at}-write`);
        // The first visit's banner (phase 37g, AC1): checked in the view
        // above, then closed, for good in this browser (AC2).
        const welcome = viewer.locator(".welcome");
        if ((await welcome.count()) !== (role === "read" ? 0 : width === 1440 ? 1 : 0)) {
          problems.push(`${at}: ${await welcome.count()} first visit's banners`);
        }
        if (await welcome.count()) {
          await viewer.click(".welcome-done");
          await viewer.waitForTimeout(200);
        }
        // The first hints (phase 37h, AC4, AC5), once each in this
        // browser: a heading's line clicked, then a diagram's.
        if (role === "edit" && width === 1440) {
          for (const [text, label] of [
            ["Décisions", "markup"],
            ["flowchart LR", "diagram"],
          ]) {
            await viewer.locator(".cm-line", { hasText: text }).first().click();
            await viewer.waitForTimeout(300);
            if (!(await viewer.locator(".first-hint").isVisible())) {
              problems.push(`${at}: no first hint for the ${label}`);
              continue;
            }
            await check(viewer, `${at}-hint-${label}`);
            await viewer.keyboard.press("Escape");
            await viewer.waitForTimeout(200);
            if (await viewer.locator(".first-hint").count()) {
              problems.push(`${at}: the ${label}'s hint stays after Escape`);
            }
          }
        }
        // The document's text larger on a wide view (phase 37e), its lines
        // no longer for it: under 100 characters.
        {
          const text = await viewer.evaluate(() => {
            const element = [...document.querySelectorAll(".view-editor > .cm-editor .cm-content, .view-editor > .preview")].find(
              (e) => e.getBoundingClientRect().width > 0,
            );
            const style = getComputedStyle(element);
            const probe = document.createElement("span");
            probe.textContent = "Nous publierons la version 1.0 à la fin du mois, après une semaine".repeat(4);
            // Beside it, in its font: CodeMirror reads its own DOM as typing.
            probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`;
            document.body.append(probe);
            const perChar = probe.getBoundingClientRect().width / probe.textContent.length;
            probe.remove();
            const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return { size: parseFloat(style.fontSize), chars: Math.round(width / perChar) };
          });
          const wanted = width === 1440 ? 17 : 15;
          if (text.size !== wanted || text.chars >= 100) {
            problems.push(`${at}: the document's text at ${text.size}px (${wanted} wanted), ${text.chars} characters a line`);
          }
        }
        // The source, where the editor shows (phase 11, decision 4).
        const source = viewer.locator(".source-toggle");
        if (await source.isVisible()) {
          const was = await viewShown(viewer);
          await source.click();
          await viewer.waitForTimeout(300);
          await check(viewer, `${at}-source`);
          await viewBack(viewer, was);
        }
        // The view chosen at a place of its own (ADR-0065): no view, nor
        // side by side, moves its control.
        if (await viewer.locator(".view-choice").isVisible()) {
          const was = await viewShown(viewer);
          const place = async () => {
            await viewer.waitForTimeout(300);
            return viewer.evaluate(() => {
              scrollTo(0, 0);
              const box = document.querySelector(".view-choice").getBoundingClientRect();
              return `${Math.round(box.x)},${Math.round(box.y)}`;
            });
          };
          const places = new Set();
          for (const toggle of ["formatted-toggle", "source-toggle", "preview-toggle"]) {
            await viewer.click(`.view-choice .${toggle}`);
            places.add(await place());
            const side = viewer.locator(".side-toggle:not([inert])");
            if (await side.isVisible()) {
              await side.click();
              places.add(await place());
              await side.click();
            }
          }
          if (places.size > 1) problems.push(`${at}: the view choice moves as the view changes (${[...places].join(" ")})`);
          await viewBack(viewer, was);
        }
        // Who wrote (ADR-0059): on, the text tinted and the legend over
        // it, the caret in the text; off again for the views after.
        const whoWrote = viewer.locator(".authorship-toggle");
        if (await whoWrote.isVisible()) {
          await whoWrote.click();
          const line = viewer.locator(".cm-line", { hasText: "fuzzing" }).first();
          if (await line.isVisible()) await line.click();
          await viewer.waitForTimeout(300);
          if (!(await viewer.locator(".authorship-legend:not([hidden])").isVisible())) {
            problems.push(`${at}: no legend once "who wrote" is on`);
          }
          // ADR-0061: each person's text underlined, dotted, in their
          // line; under a highlight, the highlight's background shows.
          // In the editor, where it shows (a reader may open on the preview).
          if (await viewer.locator(".cm-content").first().isVisible()) {
            const marks = await viewer.evaluate(() => {
              const mark = document.querySelector(".cm-author");
              const lit = document.querySelector(".cm-md-highlight");
              const inner = lit?.querySelector(".cm-author");
              return {
                style: mark && getComputedStyle(mark).textDecorationStyle,
                lit: lit && getComputedStyle(lit).backgroundColor,
                inner: inner ? getComputedStyle(inner).backgroundColor : "rgba(0, 0, 0, 0)",
              };
            });
            if (marks.style !== "dotted") problems.push(`${at}: who wrote's underline is ${marks.style}`);
            if (marks.lit === null || marks.lit === "rgba(0, 0, 0, 0)") problems.push(`${at}: no highlight under who wrote`);
            if (marks.inner !== "rgba(0, 0, 0, 0)") problems.push(`${at}: a person's tint (${marks.inner}) covers the highlight`);
          }
          await check(viewer, `${at}-who-wrote`);
          // The preview's bars, each at the column's right edge (a table,
          // a quotation, narrower than it, included).
          // A reader opens on the preview: shown already.
          const preview = viewer.locator(".preview-toggle");
          const was = await viewShown(viewer);
          const shown = await viewer.locator(".view-editor .preview").first().isVisible();
          if (shown || (await preview.isVisible())) {
            if (!shown) await preview.click();
            await viewer.waitForTimeout(400);
            const off = await viewer.evaluate(() => {
              const root = document.querySelector(".preview.authorship-on");
              if (!root) return ["no preview on"];
              const style = getComputedStyle(root);
              const edge =
                root.getBoundingClientRect().right -
                parseFloat(style.borderRightWidth) -
                parseFloat(style.paddingRight) -
                (root.offsetWidth - root.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth));
              const found = [];
              const blocks = root.querySelectorAll(":scope > [data-authors]");
              for (const block of blocks) {
                const box = block.getBoundingClientRect();
                const after = getComputedStyle(block, "::after");
                const own = getComputedStyle(block);
                const right =
                  after.content !== "none" && after.position === "absolute"
                    ? box.left + parseFloat(own.borderLeftWidth) + parseFloat(after.left) + parseFloat(after.width)
                    : box.right;
                if (Math.abs(right - edge) > 1)
                  found.push(`${block.tagName.toLowerCase()} ends at ${right.toFixed(1)}, the column at ${edge.toFixed(1)}`);
              }
              return blocks.length > 0 ? found : ["no bar"];
            });
            for (const found of off) problems.push(`${at}-who-wrote-preview: ${found}`);
            await check(viewer, `${at}-who-wrote-preview`);
            if (!shown) await viewBack(viewer, was);
          }
          await whoWrote.click();
          await viewer.waitForTimeout(200);
        }
        // The formatting toolbar (phase 20): its menu open (Insert, More
        // on the narrow view), then the toolbar hidden, and shown again.
        const formatMenu = viewer.locator('.format-toolbar [aria-haspopup="menu"]');
        if (await formatMenu.isVisible()) {
          await viewer.locator(".cm-content").click({ position: { x: 20, y: 160 } });
          await formatMenu.click();
          await viewer.waitForTimeout(200);
          await check(viewer, `${at}-format-menu`);
          await viewer.keyboard.press("Escape");
          await viewer.click(".format-toolbar .hide-toolbar");
          await viewer.waitForTimeout(200);
          await check(viewer, `${at}-format-hidden`);
          await viewer.click(".format-toolbar .show-toolbar");
          await viewer.waitForTimeout(200);
          // The writing help (phase 20d), from the toolbar.
          await viewer.click(".format-toolbar .toolbar-help");
          await viewer.waitForTimeout(300);
          await check(viewer, `${at}-help`);
          // Wide where the view is (phase 37c): what one gets has at least
          // the room of what one types.
          if (width === 1440) {
            const help = await viewer.evaluate(() => {
              const dialog = document.querySelector("dialog.help-dialog");
              const [, typed, got] = [...document.querySelectorAll(".help-examples thead th")].map(
                (th) => th.getBoundingClientRect().width,
              );
              const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
              return { dialog: dialog.getBoundingClientRect().width / rem, typed, got };
            });
            if (help.dialog < 56 || help.got < help.typed) {
              problems.push(
                `${at}-help: ${help.dialog.toFixed(1)}rem wide, ${Math.round(help.got)}px for what one gets, ${Math.round(help.typed)}px for what one types`,
              );
            }
          } else {
            // Narrow, each construction on its lines, across the dialog.
            const narrowest = await viewer.evaluate(() => {
              const body = document.querySelector("dialog.help-dialog .writing-help").getBoundingClientRect();
              const rows = [...document.querySelectorAll(".help-examples > tbody > tr")];
              return Math.min(...rows.map((row) => row.getBoundingClientRect().width)) / body.width;
            });
            if (narrowest < 0.95) {
              problems.push(`${at}-help: a construction across ${Math.round(narrowest * 100)} % of the dialog`);
            }
          }
          // Its end, « Good to know »: the dialog scrolls.
          await viewer.locator("dialog.help-dialog .help-notes").scrollIntoViewIfNeeded();
          await viewer.waitForTimeout(200);
          await check(viewer, `${at}-help-end`);
          await viewer.keyboard.press("Escape");
          await viewer.waitForTimeout(200);
        }
        // The / menu (phase 20c): open on a new line, then the typing
        // taken back, the document as it was for the views after.
        if (role === "edit") {
          await viewer.locator(".cm-line").nth(5).click();
          await viewer.keyboard.press("End");
          await viewer.keyboard.press("Enter");
          await viewer.keyboard.type("/");
          await viewer.waitForTimeout(300);
          if (!(await viewer.locator('.cm-slash-menu[role="listbox"]').isVisible())) {
            problems.push(`${at}: the / menu didn't open`);
          }
          await check(viewer, `${at}-slash-menu`);
          await viewer.keyboard.press("Escape");
          await viewer.keyboard.press("Backspace");
          // A link's headings (phase 20, decision 9), on the same line.
          await viewer.keyboard.type("[t](#");
          await viewer.waitForTimeout(300);
          if (!(await viewer.locator('.cm-anchor-menu[role="listbox"]').isVisible())) {
            problems.push(`${at}: the menu of a link's headings didn't open`);
          }
          await check(viewer, `${at}-anchor-menu`);
          await viewer.keyboard.press("Escape");
          for (let i = 0; i < 6; i++) await viewer.keyboard.press("Backspace");
          await viewer.waitForTimeout(200);
        }
        // An addition at a heading's start (phase 24): the composer asks
        // where, a paragraph before it or in its line.
        if (role === "suggest") {
          await viewer.locator(".cm-line", { hasText: "Décisions" }).first().click();
          await viewer.keyboard.press("Home");
          await viewer.waitForTimeout(200);
          await viewer.locator(".selection-toolbar > button").first().click();
          await viewer.waitForTimeout(200);
          if (!(await viewer.locator(".composer-place").isVisible())) {
            problems.push(`${at}: no choice of place at a heading's start`);
          }
          await check(viewer, `${at}-addition-place`);
          await viewer.keyboard.press("Escape");
          await viewer.waitForTimeout(200);
        }
        // The outline (phase 16): a column on the wide screen, open
        // there by default, closed and opened again; a drawer on the
        // narrow one, which a heading chosen closes.
        if (width === 1440) {
          await viewer.click(".outline-close");
          await viewer.waitForTimeout(200);
          await check(viewer, `${at}-outline-closed`);
          await viewer.click(".outline-toggle");
          await viewer.waitForTimeout(200);
        } else {
          await viewer.click(".outline-toggle");
          await viewer.waitForTimeout(300);
          await check(viewer, `${at}-outline`);
          await viewer.locator(".outline-item").last().click();
          await viewer.waitForTimeout(300);
          if (await viewer.locator(".outline-drawer[open]").count()) {
            problems.push(`${at}: the outline's drawer stayed open after a heading was chosen`);
          }
        }
        if (role === "edit") {
          const contrast = await caretContrast(viewer);
          if (contrast < 3) {
            problems.push(`${at}: the caret's contrast is ${contrast.toFixed(2)}, under 3`);
          }
        }
        // The thread and the reply field on the active card, in the
        // margin: the cards below make room (phase 13b).
        const card = viewer.locator(".layout-margin .annotation-item").first();
        if (width === 1440 && (await card.isVisible())) {
          await card.click();
          await viewer.waitForTimeout(200);
          const replyOpen = viewer.locator(".annotation-item.active .reply-open");
          if (await replyOpen.isVisible()) {
            await replyOpen.click();
            await viewer.waitForTimeout(200);
          }
          await check(viewer, `${at}-margin-thread`);
          await viewer.keyboard.press("Escape");
          // A signed name's mark, opened (phase 18g): what it says.
          const mark = viewer.locator(".annotation-item.active .signature-mark").first();
          if (await mark.isVisible()) {
            await mark.click();
            await viewer.waitForTimeout(150);
            await check(viewer, `${at}-signature`);
            await mark.click();
          }
        }
        // The closed annotations, and the text a card covered (ADR-0052):
        // narrow, in the sheet, every card shown.
        const toggle = viewer.locator(".margin-toggle");
        const sheet = width === 390 && (await toggle.isVisible());
        if (sheet) {
          await toggle.click();
          await viewer.waitForTimeout(200);
          await viewer.locator(".sheet-all").click();
          await viewer.waitForTimeout(200);
        }
        const filter = viewer.locator(".annotations-filter");
        if (!(await filter.isVisible())) {
          problems.push(`${at}: no filter of the annotations`);
        } else {
          const deleted = viewer.locator(".open-list .annotation-item", { hasText: "Laquelle ?" });
          if (!(await deleted.locator(".card-deleted").isVisible())) {
            problems.push(`${at}: the card of a deleted passage doesn't say so`);
          }
          await deleted.click();
          await deleted.locator(".see-text").click();
          await viewer.waitForTimeout(200);
          if (!((await deleted.locator(".then-quote").textContent()) ?? "").includes("police")) {
            problems.push(`${at}: the deleted passage's text is not shown`);
          }
          await check(viewer, `${at}-deleted-text`);
          await filter.locator('[data-filter="closed"]').click();
          await viewer.waitForTimeout(200);
          const closedCard = viewer.locator(".closed-list .annotation-item").first();
          if (!(await closedCard.isVisible())) {
            problems.push(`${at}: no closed card under « Closes »`);
          } else {
            const id = await closedCard.getAttribute("data-id");
            await closedCard.locator(".see-text").click();
            await viewer.waitForTimeout(300);
            // In the margin, it stands by its marked text; in the sheet, it
            // stays (ADR-0053).
            const card = viewer.locator(`.annotation-item[data-id="${id}"]`);
            const where = await card.evaluate((item) => item.parentElement?.className ?? "");
            if (!sheet && !where.includes("open-list")) {
              problems.push(`${at}: the closed card shown is not in the margin`);
            }
            if (sheet && !where.includes("closed-list")) {
              problems.push(`${at}: the closed card shown left the sheet's list`);
            }
            const editorShown = await viewer.locator(".cm-editor").first().isVisible();
            if (editorShown && !(await viewer.locator(".cm-located, .cm-located-point").first().isVisible())) {
              problems.push(`${at}: the closed card's text is not marked`);
            }
            await check(viewer, `${at}-closed`);
            await card.locator(".see-text").click();
            await viewer.waitForTimeout(300);
            if (await viewer.locator(".cm-located, .cm-located-point").count()) {
              problems.push(`${at}: the mark stays once the text is hidden`);
            }
          }
          await filter.locator('[data-filter="open"]').click();
          await viewer.waitForTimeout(200);
        }
        if (sheet) {
          await viewer.locator(".sheet-all").click();
          await viewer.locator(".sheet-close").click();
          await viewer.waitForTimeout(200);
        }
        if (width === 1440) {
          // Side by side (ADR-0064, AC9): in Source, on wide screens only.
          const was = await viewShown(viewer);
          await viewer.click(".source-toggle");
          const side = viewer.locator(".side-toggle");
          await side.click();
          await viewer.waitForTimeout(400);
          await check(viewer, `${at}-side`);
          await side.click();
          await viewBack(viewer, was);
        }
        // The text at the same place in the editor and the preview (phase
        // 37b): switching between them doesn't move it.
        const textBox = (selector) =>
          viewer.evaluate((selector) => {
            const element = document.querySelector(selector);
            if (!element) return undefined;
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return [
              Math.round(box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)),
              Math.round(box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)),
            ];
          }, selector);
        const written = (await viewer.locator(".view-editor > .cm-editor").isVisible())
          ? await textBox(".view-editor > .cm-editor .cm-content")
          : undefined;
        const wasShown = await viewShown(viewer);
        const preview = viewer.locator(".preview-toggle");
        await preview.click();
        await viewer.waitForTimeout(400);
        const read = await textBox(".view-editor > .preview");
        if (written && String(written) !== String(read)) {
          problems.push(`${at}: the text spans ${written} in the editor, ${read} in the preview`);
        }
        if (!(await viewer.locator(".preview .mermaid > svg").count())) {
          problems.push(`${at}-preview: the diagram is not drawn`);
        }
        await check(viewer, `${at}-preview`);
        await viewBack(viewer, wasShown);
        await modes.nth(1).click();
        await viewer.waitForTimeout(300);
        await check(viewer, `${at}-review`);
        // The reply field open, on the card the sheet shows (phase 13b).
        const replyOpen = viewer.locator(".layout-sheet .reply-open");
        if (await replyOpen.isVisible()) {
          await replyOpen.click();
          await viewer.fill(".layout-sheet .reply-text", "Une réponse");
          await check(viewer, `${at}-review-reply`);
          await viewer.keyboard.press("Escape");
        }
        // An editor's walk of what awaits its reply (ADR-0050 §5).
        const walkChoice = viewer.locator(".walk-choice button");
        if (await walkChoice.first().isVisible()) {
          await walkChoice.nth(1).click();
          await viewer.waitForTimeout(200);
          await check(viewer, `${at}-review-awaiting`);
          await walkChoice.nth(0).click();
        }
        // A name under two keys, its keys listed, one brought forward
        // (ADR-0051 §3, §4): the others dimmed, its chip in the bar.
        const twoKeys = viewer.locator(".signature.warn .signature-mark:visible").first();
        if (await twoKeys.count()) {
          await twoKeys.click();
          await viewer.waitForTimeout(150);
          await viewer.locator(".key-highlight:visible").first().click();
          await viewer.waitForTimeout(200);
          if (!(await viewer.locator(".key-nav").isVisible())) {
            problems.push(`${at}: no chip for the key brought forward`);
          }
          await check(viewer, `${at}-review-key`);
          keysChecked++;
          await viewer.locator(".key-nav-close").click();
          await twoKeys.click();
        }
        await modes.nth(2).click();
        await viewer.waitForTimeout(400);
        await viewer.locator(".history-entry").first().click();
        await viewer.waitForTimeout(300);
        await check(viewer, `${at}-history`);
        await modes.nth(0).click();
        if (role === "edit") {
          await viewer.click(".share-button");
          await check(viewer, `${at}-share`);
          await viewer.keyboard.press("Escape");
        }
        await viewer.click(".document-button");
        // Who writes: the signing key's fingerprint, to give (ADR-0051).
        if (role !== "read") {
          await viewer
            .waitForSelector(".document-dialog .signing-key code", { timeout: 15000 })
            .catch(() => problems.push(`${at}: no signing key in the document menu`));
          // The notifications, offered (ADR-0060 §1): the browser not asked yet.
          if ((await viewer.locator(".document-dialog .alerts-request").count()) === 0) {
            problems.push(`${at}: no offer of notifications in the document menu`);
          }
          // This device, page closed (ADR-0060 §4): the server posts.
          await viewer
            .waitForSelector(".document-dialog .push-offer", { timeout: 15000 })
            .catch(() => problems.push(`${at}: no offer of this device's notifications`));
        }
        await check(viewer, `${at}-document`);
        await viewer.keyboard.press("Escape");
        // The invitation to be notified (phase 34j): after a reply of mine,
        // under the header, both tiers offered; at 390 too, same view.
        if (role !== "read" && width === 1440) {
          await reply(viewer, "Merci");
          await viewer
            .waitForSelector(".alerts-invite .invite-device", { timeout: 15000 })
            .catch(() => problems.push(`${at}: no invitation to be notified after a reply`));
          await inSight(viewer, `${at}-invite`);
          await check(viewer, `${at}-invite`);
          await viewer.setViewportSize({ width: 390, height: 844 });
          await viewer.waitForTimeout(300);
          await inSight(viewer, `${scheme}-${role}-390-invite`);
          await check(viewer, `${scheme}-${role}-390-invite`);
          await viewer.setViewportSize({ width, height: 900 });
        }
      }
    }
    // The list, filled by the documents opened above.
    for (const width of [1440, 390]) {
      await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await viewer.goto(`${base}/`);
      await viewer.waitForSelector(".home-entry", { timeout: 15000 });
      await check(viewer, `${scheme}-home-list-${width}`);
      // Adding a device (18f): the code shown; at 390, the telephone that
      // scans it, a browser of its own, opens the same list.
      await viewer.click(".home-add-device");
      await viewer.waitForSelector(".home-pairing-qr", { timeout: 15000 });
      await check(viewer, `${scheme}-home-pairing-${width}`);
      const address = await viewer.inputValue(".home-pairing-link");
      await viewer.click(".home-pairing-done");
      if (width === 390) {
        const phone = await newPage(scheme);
        await phone.setViewportSize({ width, height: 844 });
        await phone.goto(address);
        await phone.waitForSelector(".home-entry", { timeout: 15000 });
        await check(phone, `${scheme}-home-paired-${width}`);
        await phone.context().browser()?.close();
      }
    }
    // Signing in (18i.2): the window held at the gateway, then let go; the
    // page of the return, opened by itself. The identity without a list
    // yet, whatever the scheme before left (18o.2).
    accountKeyring.version = 0;
    accountKeyring.blob = Buffer.alloc(0);
    for (const width of [1440, 390]) {
      await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await viewer.goto(`${base}/`);
      await viewer.waitForSelector(".home-sign-in:not([disabled])", { timeout: 15000 });
      let release = () => {};
      viewer.context().gateway.held = new Promise((done) => {
        release = done;
      });
      // The window is a page for Playwright once its first navigation,
      // held here, has ended.
      const popup = viewer.waitForEvent("popup");
      await viewer.click(".home-sign-in");
      await viewer.waitForSelector(".home-sign-in-cancel", { timeout: 15000 });
      await check(viewer, `${scheme}-home-signing-in-${width}`);
      release();
      await popup;
      await viewer.waitForSelector(".home-sign-out", { timeout: 15000 });
      await check(viewer, `${scheme}-home-signed-in-${width}`);
      // Analysis 18o.2: this browser's list holds documents, the
      // identity none: « Associer ces N documents à votre identité … ? ».
      try {
        await viewer.waitForSelector(".home-associate", { timeout: 15000 });
        await check(viewer, `${scheme}-home-associate-${width}`);
      } catch {
        problems.push(`${scheme}-home-associate-${width}: no question to associate the list`);
      }
      // The identity line of the document menu, signed in.
      await open(viewer, links.edit);
      await viewer.click(".document-button");
      try {
        await viewer.waitForSelector(".identity-line .identity-who", { timeout: 15000 });
        await check(viewer, `${scheme}-identity-line-${width}`);
      } catch {
        problems.push(`${scheme}-identity-line-${width}: no identity in the document menu`);
      }
      await viewer.keyboard.press("Escape");
      await viewer.goto(`${base}/`);
      await viewer.waitForSelector(".home-sign-out", { timeout: 15000 });
      await viewer.click(".home-sign-out");
      await viewer.waitForSelector(".home-sign-in", { timeout: 15000 });
    }
    // Decision 20: signed out, the first comment asks whether to sign in;
    // « Continuer sans » lets it through.
    {
      const asked = await newPage(scheme, { ask: true });
      for (const width of [1440, 390]) {
        await asked.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await open(asked, links.edit);
        // IC5 precised: signed out, the sign-in in the bar.
        try {
          await asked.waitForSelector(".identity-chip", { timeout: 15000 });
          await check(asked, `${scheme}-sign-in-chip-${width}`);
        } catch {
          problems.push(`${scheme}-sign-in-chip-${width}: no sign-in in the bar`);
        }
        await selectWord(asked, "semaine");
        await asked.locator(".selection-toolbar > button").nth(0).click();
        await asked.fill(".composer-text", "Faut-il signer ?");
        await asked.locator(".selection-toolbar .primary").click();
        try {
          await asked.waitForSelector("dialog.sign-to-name[open]", { timeout: 15000 });
        } catch {
          problems.push(`${scheme}-sign-to-name-${width}: no question before the first signed comment`);
          continue;
        }
        await check(asked, `${scheme}-sign-to-name-${width}`);
        await asked.click(".sign-to-name-without");
        await asked.waitForSelector("dialog.sign-to-name[open]", { state: "detached", timeout: 15000 }).catch(() => {});
        // Remembered on this device: asked again only after forgetting it.
        await asked.evaluate(() => localStorage.removeItem("obsidian-collab:sign-to-name"));
      }
      await asked.context().browser()?.close();
    }
    await viewer.setViewportSize({ width: 390, height: 844 });
    await viewer.goto(`${base}/auth-return`);
    await viewer.waitForSelector("body p", { timeout: 15000 });
    await check(viewer, `${scheme}-auth-return-390`);
    await viewer.goto(`${base}/`);
    await viewer.waitForSelector(".home-entry", { timeout: 15000 });
    // The key changed (18e): the new one shown, and what it means.
    // (Below, after it: an account's list has no key to change.)
    viewer.once("dialog", (dialog) => dialog.accept());
    await viewer.click(".home-change-key");
    await viewer.waitForSelector(".home-key", { timeout: 15000 });
    await check(viewer, `${scheme}-home-key-changed-390`);
    // The list kept by the account (18i.3): attached, then a second device
    // signed in, asked for the account's key; signed out, the list waits.
    accountKeyring.version = 0;
    accountKeyring.blob = Buffer.alloc(0);
    await viewer.goto(`${base}/`);
    await signInThrough(viewer);
    await viewer.waitForSelector(".home-attach", { timeout: 15000 });
    await viewer.click(".home-attach");
    await viewer.waitForSelector(".home-attach", { state: "detached", timeout: 15000 });
    await viewer.waitForFunction(() => !document.querySelector(".home-change-key"), null, { timeout: 15000 });
    for (const width of [390, 1440]) {
      await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await check(viewer, `${scheme}-home-attached-${width}`);
    }
    // Attested (18k): the list's key registered and attested on attaching;
    // a comment written now names its author, verified, and its mark says
    // what the attestation says.
    await viewer.setViewportSize({ width: 1440, height: 900 });
    await open(viewer, `${base}/?new`);
    await viewer.click(".cm-content");
    await viewer.keyboard.insertText("Une phrase attestée, à commenter.\n");
    await annotate(viewer, "attestée", 0, "Signé de mon nom.");
    for (const width of [1440, 390]) {
      await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const card = viewer.locator(".annotation-item").first();
      if (width === 390) {
        await viewer.locator(".modes button").nth(1).click();
        await viewer.waitForTimeout(300);
      } else {
        await card.click();
      }
      const shown = viewer.locator(".signature.attested .signature-mark").first();
      try {
        await shown.waitFor({ timeout: 15000 });
      } catch {
        problems.push(`${scheme}-attested-${width}: no verified mark`);
        continue;
      }
      await shown.click();
      await viewer.waitForTimeout(150);
      await check(viewer, `${scheme}-attested-${width}`);
      await shown.click();
      if (width === 390) await viewer.locator(".modes button").nth(0).click();
      // The identity line, the name carried (18o.2).
      await viewer.click(".document-button");
      try {
        await viewer.waitForSelector(".identity-line .identity-ok", { timeout: 15000 });
        // Signed in, the name is the identity's, not to change (18o.2).
        if (!(await viewer.locator(".pseudonym-input").isDisabled())) {
          problems.push(`${scheme}-identity-attested-${width}: the name can be changed while signed in`);
        }
        await check(viewer, `${scheme}-identity-attested-${width}`);
      } catch {
        problems.push(`${scheme}-identity-attested-${width}: the menu doesn't say the name is carried`);
      }
      await viewer.keyboard.press("Escape");
    }
    await viewer.goto(`${base}/`);
    await viewer.waitForSelector(".home-sign-out", { timeout: 15000 });
    await viewer.setViewportSize({ width: 390, height: 844 });
    {
      const second = await newPage(scheme);
      await second.setViewportSize({ width: 390, height: 844 });
      await second.goto(`${base}/`);
      await signInThrough(second);
      // The identity has a list: its key asked at once (18o.2).
      await second.waitForSelector(".home-account-key", { timeout: 15000 });
      await check(second, `${scheme}-home-needs-key-390`);
      await second.fill(".home-account-key", "oc-keyring:v1:x");
      await second.click(".home-use-account-key");
      await second.waitForSelector(".home-account-list .home-error", { timeout: 15000 });
      await check(second, `${scheme}-home-needs-key-error-390`);
      await second.context().browser()?.close();
    }
    await viewer.click(".home-sign-out");
    await viewer.waitForSelector(".home-message", { timeout: 15000 });
    await check(viewer, `${scheme}-home-attached-signed-out-390`);
    // Another person signs in on this browser (18o.2): the list here is
    // the first one's — said, with what to do.
    person.name = "Grace Hopper";
    person.email = "grace@example.org";
    person.sub = "u-2";
    await signInThrough(viewer);
    try {
      await viewer.waitForSelector(".home-other", { timeout: 15000 });
      for (const width of [390, 1440]) {
        await viewer.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await check(viewer, `${scheme}-home-other-identity-${width}`);
      }
    } catch {
      problems.push(`${scheme}-home-other-identity: another identity's list not said`);
    }
    await viewer.click(".home-sign-out");
    person.name = "Mathieu Clabaut";
    person.email = "mathieu@example.org";
    person.sub = "u-1";
    await viewer.context().browser()?.close();
    // The identity to confirm (18o.3): the list's key not registered for
    // want of a recent sign-in — said at the home page, in the
    // document's bar, and asked when writing.
    accountKeyring.version = 0;
    accountKeyring.blob = Buffer.alloc(0);
    account.key = undefined;
    account.notRecent = true;
    const confirming = await newPage(scheme, { ask: true });
    try {
      await confirming.goto(`${base}/`);
      await signInThrough(confirming);
      await confirming.waitForSelector(".home-confirm-identity", { timeout: 15000 });
      for (const width of [390, 1440]) {
        await confirming.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await check(confirming, `${scheme}-home-confirm-${width}`);
      }
      await open(confirming, `${base}/?new`);
      await confirming.waitForSelector(".identity-chip", { timeout: 15000 });
      for (const width of [1440, 390]) {
        await confirming.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await check(confirming, `${scheme}-identity-chip-${width}`);
      }
      await confirming.setViewportSize({ width: 1440, height: 900 });
      await confirming.click(".cm-content");
      await confirming.keyboard.insertText("Une phrase à confirmer.\n");
      await annotate(confirming, "confirmer", 0, "À mon nom ?");
      await confirming.waitForSelector(".sign-to-name-confirm", { timeout: 15000 });
      await check(confirming, `${scheme}-sign-to-name-confirm-1440`);
    } catch (error) {
      problems.push(`${scheme}-identity-to-confirm: ${error.message}`);
    } finally {
      account.notRecent = false;
      await confirming.context().browser()?.close();
    }
  }
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  server.kill();
  rmSync(data, { recursive: true, force: true });
}

console.log(`${checked} views checked`);
if (keysChecked === 0) problems.push("no name under two keys: no key brought forward");
if (problems.length > 0) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("no serious or critical violation, no horizontal scroll");
