// @vitest-environment node
//
// Phase 18l, end to end: the real server, the real gateway, a test
// identity provider (oauth2-mock-server, cooperative: refusals are
// `cargo test`'s, against wiremock), and Chromium under the page's own
// policy. A signs in from the home (a recent sign-in: no attestation
// yet), attaches its list, writes a comment that reads « verified »
// under the attested name. B, a participant without an account, is asked
// decision 20's question, continues without, sees A's name verified and
// writes a comment that reads « signed ». C, A's second device, gets the
// list through the account's pairing. A's key replaced at the gateway is
// revoked, the list pushed to the server, and B sees it; A draws a new
// signing key (phase 30), and its next comment is verified. Through every
// request the pages send and every frame on the relay: neither a
// document's key or secret, nor K_t, nor P (TR3); the gateway asked only
// its own paths, the server never a token.
import { type ChildProcess, spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const SERVER_PORT = 18090;
const GATEWAY_PORT = 18091;
const IDP_PORT = 18092;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`;
const CLIENT_ID = "collab-gateway";
const RELAY = `ws://127.0.0.1:${SERVER_PORT}/ws`;

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** §6.2's encoding, for texts, bytes and maps: what a proof signs. */
function cbor(
  value: string | Buffer | Record<string, string | Buffer>,
): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  const pairs = Object.entries(value)
    .map(([k, v]) => [cbor(k), cbor(v)] as const)
    .sort(([x], [y]) => Buffer.compare(x, y));
  return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
}
const sha256 = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest();

// The gateway's attestation key, fixed: the server is told its fingerprint.
const SEED = Buffer.alloc(32, 0x42);
const attestationPublic = createPublicKey(
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      SEED,
    ]),
    format: "der",
    type: "pkcs8",
  }),
)
  .export({ format: "der", type: "spki" })
  .subarray(12);
const FINGERPRINT = sha256(attestationPublic).toString("hex");
// The push secret, and its verifier as K-8 computes it (ID-33).
const PUSH_SECRET = Buffer.alloc(32, 0x71);
const PUSH_VERIFIER = createHash("sha256")
  .update("obsidian-collab/verifier/v1")
  .update(Buffer.from([0]))
  .update("revocations")
  .update(Buffer.from([0]))
  .update(PUSH_SECRET)
  .digest("hex");

const children: ChildProcess[] = [];
// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let idp: any;
// biome-ignore lint/suspicious/noExplicitAny: playwright-core, outside the project.
let chromium: any;
// biome-ignore lint/suspicious/noExplicitAny: idem.
const browsers: any[] = [];

async function until(check: () => Promise<boolean>, what: string, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-gateway-e2e-"));
  // The identity provider: whoever logs in is u-1, recently.
  const { OAuth2Server } = await import(
    path.join(
      ROOT,
      "choice/keyring/node_modules/oauth2-mock-server/dist/index.mjs",
    )
  );
  idp = new OAuth2Server();
  await idp.issuer.keys.generate("RS256");
  idp.service.on(
    "beforeTokenSigning",
    // biome-ignore lint/suspicious/noExplicitAny: the mock's own types.
    (token: any, req: any) => {
      if (req.body?.grant_type !== "authorization_code") return;
      Object.assign(token.payload, {
        sub: "u-1",
        name: "Ada Lovelace",
        email: "ada@example.org",
        auth_time: Math.floor(Date.now() / 1000),
      });
    },
  );
  await idp.start(IDP_PORT, "127.0.0.1");

  const keyPath = path.join(dir, "attestation.key");
  writeFileSync(keyPath, `${b64url(SEED)}\n`, { mode: 0o600 });
  children.push(
    spawn(path.join(ROOT, "server/target/debug/gateway"), [], {
      env: {
        ...process.env,
        GATEWAY_BIND_ADDR: `127.0.0.1:${GATEWAY_PORT}`,
        GATEWAY_DATABASE_PATH: path.join(dir, "gateway.sqlite3"),
        OIDC_ISSUER: idp.issuer.url,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: "s3cret",
        GATEWAY_PUBLIC_URL: GATEWAY,
        SERVER_ORIGIN: SERVER,
        SERVER_URL: SERVER,
        REVOCATIONS_SECRET: b64url(PUSH_SECRET),
        ATTESTATION_KEY_PATH: keyPath,
      },
      stdio: "ignore",
    }),
    spawn(path.join(ROOT, "server/target/debug/server"), [], {
      env: {
        ...process.env,
        BIND_ADDR: `127.0.0.1:${SERVER_PORT}`,
        DATABASE_PATH: path.join(dir, "server.sqlite3"),
        GATEWAY_URL: GATEWAY,
        GATEWAY_ATTESTATION_KEYS: FINGERPRINT,
        REVOCATIONS_VERIFIER: PUSH_VERIFIER,
      },
      stdio: "ignore",
    }),
  );
  await until(
    async () => (await fetch(`${GATEWAY}/accounts/health`)).status === 200,
    "the gateway",
  );
  await until(
    async () => (await fetch(`${SERVER}/`)).status === 200,
    "the server",
  );
  ({ chromium } = await import(
    path.join(ROOT, "choice/render/node_modules/playwright-core/index.mjs")
  ));
}, 60000);

afterAll(async () => {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const child of children) child.kill();
  await idp?.stop();
});

/** A's account key, shown at its home (the first scenario). */
let accountKeyOfA = "";

/** What the pages sent: every request, every frame. */
const sent: { url: string; headers: string; body: string }[] = [];

/** A page in a browser of its own (one context per --single-process
 * Chromium), under the page's policy. */
async function newPage(name: string, options: { asked?: boolean } = {}) {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--single-process", "--disable-crashpad-for-testing"],
  });
  browsers.push(browser);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "fr-FR",
  });
  await context.addInitScript(
    ([pseudonym, asked]: [string, boolean]) => {
      try {
        localStorage.setItem("obsidian-collab:pseudonym", pseudonym);
        if (!asked) {
          localStorage.setItem("obsidian-collab:sign-to-name", "without");
        }
      } catch {}
    },
    [name, options.asked ?? false],
  );
  // biome-ignore lint/suspicious/noExplicitAny: playwright's own types.
  context.on("request", (request: any) => {
    sent.push({
      url: request.url(),
      headers: JSON.stringify(request.headers()),
      body: request.postDataBuffer()?.toString("latin1") ?? "",
    });
  });
  const page = await context.newPage();
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  page.on("websocket", (ws: any) =>
    // biome-ignore lint/suspicious/noExplicitAny: idem.
    ws.on("framesent", (frame: any) =>
      sent.push({
        url: ws.url(),
        headers: "",
        body: Buffer.from(frame.payload).toString("latin1"),
      }),
    ),
  );
  return page;
}

// biome-ignore lint/suspicious/noExplicitAny: idem.
type Page = any;

async function signInFromHome(page: Page) {
  await page.goto(`${SERVER}/`);
  await page.waitForSelector(".home-sign-in:not([disabled])", {
    timeout: 20000,
  });
  const popup = page.waitForEvent("popup");
  await page.click(".home-sign-in");
  await popup;
  await page.waitForSelector(".home-sign-out", { timeout: 30000 });
}

async function selectWord(page: Page, word: string) {
  const at = await page.evaluate((w: string) => {
    for (const line of Array.from(document.querySelectorAll(".cm-line"))) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? "").indexOf(w);
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
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(150);
}

async function comment(page: Page, word: string, text: string) {
  await selectWord(page, word);
  await page.locator(".selection-toolbar > button").nth(0).click();
  await page.fill(".composer-text", text);
  await page.locator(".selection-toolbar .primary").click();
}

/** Signs in recently at the gateway as a client outside a browser would,
 * through the provider: the token, and the code's verifier. */
async function recentToken(): Promise<string> {
  // ID-19: the challenge is SHA-256 of v's 32 bytes, not of its text.
  const v = randomBytes(32);
  const verifier = b64url(v);
  const challenge = b64url(sha256(v));
  const request = randomBytes(16).toString("hex");
  const follow = async (url: string) =>
    (await fetch(url, { redirect: "manual" })).headers.get("location") ?? "";
  const toIdp = await follow(
    `${GATEWAY}/accounts/login?request=${request}&challenge=${challenge}&fresh`,
  );
  const toCallback = await follow(toIdp);
  const toPage = await follow(toCallback);
  const code = new URLSearchParams(new URL(toPage).hash.slice(1)).get("code");
  const session = await fetch(`${GATEWAY}/accounts/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  return ((await session.json()) as { token: string }).token;
}

describe("the gateway, end to end", () => {
  test("attested, signed, paired, revoked — and nothing in clear", async () => {
    // A (analysis 18o.2): signed in from the document itself, at
    // decision 20's question, never through the home page; the list
    // associated with the identity at once (nothing here to decide), the
    // key registered (a recent sign-in: no attestation yet) and attested;
    // the comment written under the attested name.
    const a = await newPage("ada", { asked: true });
    await a.goto(`${SERVER}/?new`);
    await a.waitForSelector(".cm-content", { timeout: 20000 });
    await a.click(".cm-content");
    await a.keyboard.insertText("Le compte rendu de la réunion.\n");
    await comment(a, "réunion", "Vérifié ?");
    await a.waitForSelector("dialog.sign-to-name[open]", { timeout: 20000 });
    const signInWindow = a.waitForEvent("popup");
    await a.click(".sign-to-name-sign-in");
    await signInWindow;
    await a.waitForSelector(".signature.attested", { timeout: 30000 });
    expect(
      await a.locator(".annotation-item strong").first().textContent(),
    ).toBe("Ada Lovelace");
    // The document menu says it.
    await a.click(".document-button");
    await a.waitForSelector(".identity-ok", { timeout: 20000 });
    expect(await a.locator(".identity-who").textContent()).toBe(
      "Ada Lovelace (ada@example.org)",
    );
    await a.keyboard.press("Escape");
    const documentAddress = a.url() as string;
    // Its list, the identity's: the key shown at the home page.
    await a.goto(`${SERVER}/`);
    await a.waitForSelector(".home-show-key", { timeout: 20000 });
    await a.click(".home-show-key");
    const accountKey = (await a.inputValue(".home-key")) as string;
    accountKeyOfA = accountKey;
    const kt = accountKey.replace(/^oc-keyring:v1:/, "");
    expect(kt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await a.goto(documentAddress);
    await a.waitForSelector(".signature.attested", { timeout: 20000 });
    // A's caret, for the others to see.
    await a.click(".cm-content");
    await a.click(".share-button");
    const edit = (await a.inputValue("input.share-edit")) as string;
    await a.keyboard.press("Escape");

    // B, without an account: asked first, continues without; A's name
    // verified; its own comment signed, not attested.
    const b = await newPage("bob", { asked: true });
    await b.goto(edit);
    await b.waitForSelector(".signature.attested", { timeout: 20000 });
    // A's caret carries the attested name (18o.2).
    await until(
      async () =>
        (
          (await b.locator(".cm-remote-name").allTextContents()) as string[]
        ).includes("Ada Lovelace"),
      "A's caret under the attested name",
    );
    await comment(b, "compte", "Sans compte.");
    await b.waitForSelector("dialog.sign-to-name[open]", { timeout: 20000 });
    await b.click(".sign-to-name-without");
    await until(
      async () => (await b.locator(".annotation-item").count()) === 2,
      "B's comment",
    );
    // A sees it signed, with its key, not verified.
    await until(
      async () =>
        (await a
          .locator(".signature:not(.attested) .signature-mark")
          .count()) === 1,
      "B's comment signed at A",
    );

    // C, A's second device: the list through the account's pairing.
    await a.goto(`${SERVER}/`);
    await a.waitForSelector(".home-add-device", { timeout: 20000 });
    await a.click(".home-add-device");
    await a.waitForSelector(".home-pairing-link", { timeout: 20000 });
    const pairing = (await a.inputValue(".home-pairing-link")) as string;
    const p =
      new URLSearchParams(new URL(pairing).hash.slice(1)).get("p") ?? "";
    expect(p).not.toBe("");
    const c = await newPage("ada");
    await c.goto(pairing);
    await c.waitForSelector(".home-sign-in:not([disabled])", {
      timeout: 20000,
    });
    const popup = c.waitForEvent("popup");
    await c.click(".home-sign-in");
    await popup;
    await c.waitForSelector(".home-entry", { timeout: 30000 });

    // A's key replaced at the gateway (another key, from a recent
    // sign-in): the old one revoked, the list pushed to the server.
    const token = await recentToken();
    const next = generateKeyPairSync("ed25519");
    const nextPublic = next.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(12);
    const ordered = cbor({
      ctx: "oc-key-proof/v1",
      issuer: idp.issuer.url,
      sub: "u-1",
      key: nextPublic,
    });
    const replaced = await fetch(`${GATEWAY}/accounts/key`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        key: b64url(nextPublic),
        proof: b64url(sign(null, ordered, next.privateKey)),
      }),
    });
    expect(replaced.status).toBe(204);
    await until(async () => {
      const list = await fetch(`${SERVER}/revocations`);
      return list.status === 200;
    }, "the revocation list on the server");
    // B reads it again on opening: A's comment, dated before, still
    // verified, its key said revoked.
    await b.goto("about:blank");
    await b.goto(edit);
    await b.waitForSelector(".signature.attested.warn", { timeout: 20000 });
    await b.locator(".signature.attested .signature-mark").first().click();
    expect(
      await b.locator(".signature-details").first().textContent(),
    ).toContain("Clé révoquée le");

    // Phase 30 (ADR-0056): A's list still holds the revoked key. A's page
    // says it refused, from the revocation list though it holds an
    // attestation of it (NK2); « Nouvelle clé de signature » replaces it
    // (NK4) and registers the new one: A's next comment verified again,
    // its first one still said revoked.
    await a.goto("about:blank");
    await a.goto(documentAddress);
    await a.waitForSelector(".signature.attested", { timeout: 20000 });
    await a.click(".document-button");
    await a.waitForSelector(".identity-new-key", { timeout: 20000 });
    // The sign-in, if no more recent, opens in the same click.
    const recentAgain = a
      .waitForEvent("popup", { timeout: 5000 })
      .catch(() => undefined);
    await a.click(".identity-new-key");
    await recentAgain;
    await a.waitForSelector(".identity-ok", { timeout: 30000 });
    await a.keyboard.press("Escape");
    await comment(a, "rendu", "Avec la nouvelle clé.");
    await until(
      async () =>
        (await a.locator(".signature.attested:not(.warn)").count()) >= 1,
      "A's new comment verified, its key not revoked",
    );
    expect(await a.locator(".signature.attested.warn").count()).toBe(1);

    // TR3: the secrets of the link, K_t, P — nowhere in what was sent.
    const fragment = new URLSearchParams(new URL(edit).hash.slice(1));
    const secrets = {
      documentKey: fragment.get("k") ?? "",
      roleSecret: (fragment.get("r") ?? "").split(".")[1] ?? "",
      kt,
      p,
    };
    for (const [name, secret] of Object.entries(secrets)) {
      expect(secret.length, name).toBeGreaterThan(20);
      const leaks = sent.filter(
        (s) =>
          // A role secret authenticates on the relay, compared there with
          // its verifier (ADR-0019): there only.
          !(name === "roleSecret" && s.url === RELAY) &&
          (s.url.includes(secret) ||
            s.headers.includes(secret) ||
            s.body.includes(secret)),
      );
      expect(
        leaks.map((s) => s.url),
        `${name} sent`,
      ).toEqual([]);
    }
    // Not vacuous: the account's keyring, the relay and the list were
    // reached, and what they were sent was looked at.
    expect(sent.some((s) => s.url === `${GATEWAY}/accounts/keyring`)).toBe(
      true,
    );
    expect(sent.filter((s) => s.url === RELAY).length).toBeGreaterThan(5);
    expect(sent.some((s) => s.url === `${SERVER}/revocations`)).toBe(true);
    // The gateway: its own paths only; the server: never a token.
    const toGateway = sent.filter((s) => s.url.startsWith(GATEWAY));
    expect(toGateway.length).toBeGreaterThan(0);
    for (const s of toGateway) {
      expect(new URL(s.url).pathname, s.url).toMatch(/^\/accounts\//);
    }
    for (const s of sent.filter((s) => s.url.startsWith(SERVER))) {
      expect(s.headers.toLowerCase(), s.url).not.toContain("bearer");
    }
  }, 240000);

  // Analysis 18p.2 (the user's trial): a new browser, signed in at its
  // home while the identity's list is elsewhere (A's). A document created
  // there is kept in a list in waiting (LA1), said in the bar as a list
  // to open here, shown at the home page; the account's key pasted, it
  // joins the identity's list.
  test("a document created signed in, the identity's list elsewhere: kept, then joined", async () => {
    expect(accountKeyOfA).not.toBe("");
    const d = await newPage("ada");
    await signInFromHome(d);
    await d.waitForSelector(".home-account-key", { timeout: 20000 });
    expect(await d.locator(".home-keep").count()).toBe(0);
    await d.click(".home-new");
    await d.waitForSelector(".cm-content", { timeout: 20000 });
    await d.click(".cm-content");
    await d.keyboard.insertText("Créé en attendant.\n");
    await until(
      async () => new URL(d.url()).searchParams.has("doc"),
      "the created document's address",
    );
    const documentId = new URL(d.url()).searchParams.get("doc");
    await d.waitForSelector("a.identity-chip", { timeout: 20000 });
    expect(await d.locator("a.identity-chip").getAttribute("aria-label")).toBe(
      "Ouvrir votre liste ici",
    );
    await d.goto(`${SERVER}/`);
    await d.waitForSelector(`.home-entry[data-document="${documentId}"]`, {
      timeout: 20000,
    });
    await d.fill(".home-account-key", accountKeyOfA);
    await d.click(".home-use-account-key");
    // The identity's list here, the document in it, with A's.
    await d.waitForSelector(".home-show-key", { timeout: 30000 });
    await until(
      async () => (await d.locator(".home-entry").count()) >= 2,
      "the identity's list with the document",
    );
    expect(
      await d.locator(`.home-entry[data-document="${documentId}"]`).count(),
    ).toBe(1);
  }, 120000);

  // Analysis 18p.3 (the user's second trial): the identity's list lost —
  // no device where it is open, nor its key. A new browser, signed in at
  // its home (recently: no attestation held here), starts a new list: its
  // key shown, written over the lost one at the gateway, the list's
  // identity key registered; a document created there carries the name.
  test("the identity's list lost: started over, its key shown, the name carried again", async () => {
    expect(accountKeyOfA).not.toBe("");
    const e = await newPage("ada", { asked: true });
    await signInFromHome(e);
    await e.waitForSelector(".home-start-over", { timeout: 20000 });
    // biome-ignore lint/suspicious/noExplicitAny: playwright's own types.
    e.once("dialog", (dialog: any) => dialog.accept());
    await e.click(".home-start-over");
    await e.waitForSelector(".home-key", { timeout: 30000 });
    const key = (await e.inputValue(".home-key")) as string;
    expect(key).toMatch(/^oc-keyring:v1:[A-Za-z0-9_-]{43}$/);
    expect(key).not.toBe(accountKeyOfA);
    await e.waitForSelector(".home-show-key", { timeout: 20000 });
    expect(await e.locator(".home-start-over").count()).toBe(0);
    await e.click(".home-new");
    await e.waitForSelector(".cm-content", { timeout: 20000 });
    await e.click(".cm-content");
    await e.keyboard.insertText("Une liste recommencée.\n");
    await comment(e, "recommencée", "Signé ?");
    await e.waitForSelector(".signature.attested", { timeout: 30000 });
    expect(await e.locator("a.identity-chip").count()).toBe(0);
    // The new list holds it: the home shows it, under the key shown.
    const documentId = new URL(e.url()).searchParams.get("doc");
    await e.goto(`${SERVER}/`);
    await e.waitForSelector(`.home-entry[data-document="${documentId}"]`, {
      timeout: 20000,
    });
    await e.click(".home-show-key");
    expect(await e.inputValue(".home-key")).toBe(key);
  }, 120000);
});
