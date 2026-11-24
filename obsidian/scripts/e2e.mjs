// The plugin end to end, in the real Obsidian against the real server
// (docs/phase-14-plugin-obsidian.md, decision 10; 14g): open a link, type,
// see the export; reopen, rename, unlink, delete; share a note; change its
// file outside and resume the change; Obsidian's preview alongside; « Mes
// documents » and signing in by the system's browser, with the real
// gateway and a test identity provider (phase 18m). Each step is checked;
// a failed check fails the run. Set up and taken down by `harness.mjs` (a
// throwaway vault, the server and Obsidian under Xvfb).
//
//   (cd ../server && cargo build -p app -p gateway)
//   node scripts/e2e.mjs [--shots dir] [--keep]
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ROOT, sleep, startObsidian, until } from "./harness.mjs";

const options = { shots: "", keep: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--shots") options.shots = process.argv[++i] ?? "";
  else if (arg === "--keep") options.keep = true;
  else throw new Error(`unknown option ${arg}`);
}
if (options.shots) mkdirSync(options.shots, { recursive: true });

const failures = [];
/** A step's outcome: printed, and a failure kept unless `holds`. */
function expectThat(what, holds, detail = "") {
  console.log(
    `${holds ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`,
  );
  if (!holds) failures.push(what);
}

// Phase 18m: a test identity provider (whoever logs in is Ada, recently)
// and the real gateway, before the server, which names them.
const port = 18000 + Math.floor(Math.random() * 900);
const SERVER_ORIGIN = `http://127.0.0.1:${port}`;
const GATEWAY = `http://127.0.0.1:${port + 1000}`;
const identityDir = mkdtempSync(join(tmpdir(), "collab-link-gateway-"));
const SEED = Buffer.alloc(32, 0x42);
const FINGERPRINT = createHash("sha256")
  .update(
    createPublicKey(
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
      .subarray(12),
  )
  .digest("hex");
const { OAuth2Server } = await import(
  join(ROOT, "choice/keyring/node_modules/oauth2-mock-server/dist/index.mjs")
);
const idp = new OAuth2Server();
await idp.issuer.keys.generate("RS256");
idp.service.on("beforeTokenSigning", (token, req) => {
  if (req.body?.grant_type !== "authorization_code") return;
  Object.assign(token.payload, {
    sub: "u-1",
    name: "Ada Lovelace",
    email: "ada@example.org",
    auth_time: Math.floor(Date.now() / 1000),
  });
});
await idp.start(port + 2000, "127.0.0.1");
const keyPath = join(identityDir, "attestation.key");
writeFileSync(keyPath, `${SEED.toString("base64url")}\n`, { mode: 0o600 });
const gateway = spawn(join(ROOT, "server/target/debug/gateway"), [], {
  env: {
    ...process.env,
    GATEWAY_BIND_ADDR: `127.0.0.1:${port + 1000}`,
    GATEWAY_DATABASE_PATH: join(identityDir, "gateway.sqlite3"),
    OIDC_ISSUER: idp.issuer.url,
    OIDC_CLIENT_ID: "collab-gateway",
    OIDC_CLIENT_SECRET: "s3cret",
    GATEWAY_PUBLIC_URL: GATEWAY,
    SERVER_ORIGIN,
    ATTESTATION_KEY_PATH: keyPath,
  },
  stdio: "ignore",
  detached: true,
});
const stopIdentity = async () => {
  try {
    process.kill(-gateway.pid, "SIGTERM");
  } catch {}
  await idp.stop().catch(() => {});
  rmSync(identityDir, { recursive: true, force: true });
};
await until(
  "the gateway",
  async () => (await fetch(`${GATEWAY}/accounts/health`)).status === 200,
);

const started = await startObsidian({
  preferences: {
    "obsidian-collab:pseudonym": "Obsidian",
    // Decision 20's question answered before (« Continuer sans »): the
    // steps before phase 18 write unasked; the 14th signs in first.
    "obsidian-collab:sign-to-name": "without",
  },
  // The plugin's settings (analysis 18m, M3): the server, its gateway and
  // the fingerprint of the gateway's attestation key.
  settings: {
    server: SERVER_ORIGIN,
    gateway: GATEWAY,
    attestationKeys: FINGERPRINT,
  },
  keep: options.keep,
  port,
  serverEnv: {
    GATEWAY_URL: GATEWAY,
    GATEWAY_ATTESTATION_KEYS: FINGERPRINT,
  },
}).catch(async (error) => {
  await stopIdentity();
  throw error;
});
const {
  page,
  lib,
  server,
  vault,
  fileText,
  stop,
  openInObsidian,
  sentToBrowser,
} = started;
const ACTIVE = ".workspace-leaf.mod-active .document-view";
const shot = (name) =>
  options.shots
    ? page.screenshot({ path: join(options.shots, `${name}.png`) })
    : undefined;

/** A PNG of `width` × `height`, in stripes: big enough to see in a shot. */
function stripes(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row.set(
        Math.floor(x / 20) % 2 ? [40, 90, 200] : [240, 170, 40],
        1 + x * 3,
      );
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function newDocument() {
  const created = await lib.createDocument(server);
  return {
    id: created.documentId,
    created,
    links: await lib.documentLinks(
      `${server}/`,
      created.documentId,
      created.keyMaterial,
      created.editSecret,
    ),
  };
}
async function openLink(link) {
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:open-link"),
  );
  await page.fill(".modal input.collab-link-link", link);
  await page.click(".modal button.mod-cta");
  await page.waitForSelector(`${ACTIVE} .cm-content`, { timeout: 30_000 });
  await sleep(500);
}
async function typeInView(text) {
  await page.click(`${ACTIVE} .cm-content`);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}
const viewText = () =>
  page.evaluate(
    (view) => document.querySelector(`${view} .cm-content`)?.textContent,
    ACTIVE,
  );
const activeType = () =>
  page.evaluate(() => app.workspace.activeLeaf?.view?.getViewType());
const pluginViews = () =>
  page.evaluate(
    () => app.workspace.getLeavesOfType("collab-link-document").length,
  );

let other;
let reader;
let tracker;
let outliner;
try {
  // 1. "Open a link": a note in Collab Link/, the view on it.
  const first = await newDocument();
  await openLink(first.links.edit);
  const firstPath = await page.evaluate(
    () => app.workspace.activeLeaf?.view?.file?.path,
  );
  expectThat(
    "Open a link: a note in Collab Link/, in the plugin's view",
    firstPath?.startsWith("Collab Link/") &&
      (await activeType()) === "collab-link-document",
    firstPath,
  );

  // 2. Typing reaches another client, and its typing the view; the note
  // follows the title and is the export.
  await typeInView("# Compte rendu\n\nBonjour depuis Obsidian.");
  other = await lib.openLink(first.links.edit);
  await until("the typing reaches the other client", () =>
    other.content
      .getText("content")
      .toString()
      .includes("Bonjour depuis Obsidian."),
  );
  const text = other.content.getText("content");
  text.insert(text.length, "\n\nEt depuis Node.");
  other.content.commit();
  await until("the other's typing reaches the view", async () =>
    (await viewText())?.includes("Et depuis Node."),
  );
  await until("the note named and exported", () =>
    fileText("Collab Link/Compte rendu.md")?.includes("Et depuis Node."),
  );
  const exported = fileText("Collab Link/Compte rendu.md") ?? "";
  expectThat(
    "typing in both directions; the note named after its title, the export of the document",
    exported.includes(`collab-document: "${first.id}"`) &&
      exported.includes(
        "# Compte rendu\n\nBonjour depuis Obsidian.\n\nEt depuis Node.",
      ),
  );
  await shot("view");

  // 3. Nothing of the link in the vault's files.
  await page.evaluate(() => app.workspace.requestSaveLayout?.run?.());
  await sleep(2500);
  const parts = new URL(first.links.edit).hash
    .slice(1)
    .split(/[&=.]/)
    .filter((p) => p.length > 8);
  const leaked = [
    ".obsidian/workspace.json",
    ".obsidian/plugins/collab-link/data.json",
    "Collab Link/Compte rendu.md",
  ].filter((path) => parts.some((p) => (fileText(path) ?? "").includes(p)));
  expectThat(
    "no part of the link in the vault's files",
    leaked.length === 0,
    leaked.join(", "),
  );

  // 4. Closed, reopened as any note: the view again, the link kept.
  await page.evaluate(() => {
    for (const leaf of app.workspace.getLeavesOfType("collab-link-document")) {
      leaf.detach();
    }
  });
  await page.evaluate(() =>
    app.workspace.openLinkText("Collab Link/Compte rendu", "", true),
  );
  await page.waitForSelector(`${ACTIVE} .cm-content`, { timeout: 30_000 });
  expectThat(
    "reopened as any note: the plugin's view, the document shown",
    (await activeType()) === "collab-link-document" &&
      (await until("the text", viewText))?.includes("Et depuis Node."),
  );

  // 5. Renamed: the export follows.
  await page.evaluate(async () => {
    const file = app.vault.getAbstractFileByPath("Collab Link/Compte rendu.md");
    await app.fileManager.renameFile(file, "Compte rendu renommé.md");
  });
  await typeInView("\n\nAprès le renommage.");
  await until("the export at the new path", () =>
    fileText("Compte rendu renommé.md")?.includes("Après le renommage."),
  );
  expectThat("renamed: the export follows", true);

  // 6. Unlinked: an ordinary note with the last export.
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:unlink-note"),
  );
  await until("unlinked", async () => (await activeType()) === "markdown");
  const unlinked = fileText("Compte rendu renommé.md") ?? "";
  expectThat(
    "unlinked: an ordinary note, the last text, no header",
    !unlinked.includes("collab-document") &&
      unlinked.includes("Après le renommage."),
  );

  // 7. A second document, its note deleted: the view goes, nothing writes.
  const second = await newDocument();
  await openLink(second.links.edit);
  const secondPath = await page.evaluate(
    () => app.workspace.activeLeaf?.view?.file?.path,
  );
  await page.evaluate(async (path) => {
    await app.vault.delete(app.vault.getAbstractFileByPath(path));
  }, secondPath);
  await sleep(2500);
  expectThat(
    "deleted: its view closed, the file not written again",
    (await pluginViews()) === 0 && !existsSync(join(vault, secondPath)),
  );

  // 8. "Share this note": a note with a property and CriticMarkup, shared
  // on the server of the settings.
  const PLAN = "---\ntags: [plan]\n---\n# Plan\n\nUn {++vrai ++}brouillon.\n";
  await page.evaluate(
    async ([address, plan]) => {
      app.plugins.plugins["collab-link"].storage.setSetting("server", address);
      await app.vault.create("Plan.md", plan);
      await app.workspace.getLeaf("tab").setViewState({
        type: "markdown",
        state: { file: "Plan.md" },
        active: true,
      });
      app.commands.executeCommandById("collab-link:share-note");
    },
    [server, PLAN],
  );
  await page.click(".modal button.mod-cta");
  await page.waitForSelector(`${ACTIVE} .cm-content`, { timeout: 30_000 });
  const shared = fileText("Plan.md") ?? "";
  const sharedId = /collab-document: "([^"]+)"/.exec(shared)?.[1];
  // The link as kept, in Obsidian's secret storage (decision 5).
  const sharedLink = await page.evaluate(
    (id) =>
      app.secretStorage
        .listSecrets()
        .map((name) => app.secretStorage.getSecret(name))
        .find((value) => value?.includes(`doc=${id}`)),
    sharedId,
  );
  reader = await lib.openLink(sharedLink ?? "");
  const serverText = reader.content.getText("content").toString();
  const kinds = lib
    .listAnnotations(reader.content, reader.annotations)
    .map((a) => a.type);
  expectThat(
    "shared: on the server, the text with its header and the suggestion; the note an export, in the view",
    serverText === "---\ntags: [plan]\n---\n# Plan\n\nUn brouillon.\n" &&
      JSON.stringify(kinds) === '["addition"]' &&
      !!sharedId &&
      (await activeType()) === "collab-link-document",
    JSON.stringify(serverText),
  );

  // 9. Changed outside Obsidian (decision 4): kept in a copy, the note the
  // export again; resumed, the change reaches the server.
  const before = fileText("Plan.md") ?? "";
  writeFileSync(
    join(vault, "Plan.md"),
    before.replace("brouillon.", "brouillon, changé dehors."),
  );
  const copyName = await until("a copy", () =>
    readdirSync(vault).find((name) => name.startsWith("Plan (")),
  );
  await until(
    "the note the export again",
    () => fileText("Plan.md") === before,
  );
  const copy = fileText(copyName) ?? "";
  const said = await page.evaluate(
    () =>
      document.querySelector(".workspace-leaf.mod-active .collab-link-message")
        ?.textContent,
  );
  expectThat(
    "changed outside: a copy beside, without the link; the note rewritten; the view says where",
    copy.includes("changé dehors") &&
      copy.includes("tags: [plan]") &&
      !copy.includes("collab-document") &&
      !!said?.includes(copyName.replace(/\.md$/, "")),
    copyName,
  );
  await page.click(".workspace-leaf.mod-active .collab-link-resume");
  await until("resumed on the server", () =>
    reader.content.getText("content").toString().includes("changé dehors"),
  );
  await until("resumed in the note", () =>
    fileText("Plan.md")?.includes("changé dehors"),
  );
  const mtime = statSync(join(vault, "Plan.md")).mtimeMs;
  await sleep(4000);
  expectThat(
    "resumed: on the server and in the note, which then rests; one copy",
    statSync(join(vault, "Plan.md")).mtimeMs === mtime &&
      readdirSync(vault).filter((n) => n.startsWith("Plan (")).length === 1,
  );
  await shot("outside");

  // 10. Obsidian's preview alongside (decision 7): an editor's remote image
  // is fetched by Obsidian's editor in the view (phase 17, decision 14),
  // and by Obsidian's preview (docs/security/threat-model.md, Éditeur):
  // the limits admitted, observed.
  const fetched = [];
  tracker = createServer((request, response) => {
    fetched.push(request.url);
    response.writeHead(404).end();
  });
  await new Promise((listening) => tracker.listen(0, "127.0.0.1", listening));
  const image = `http://127.0.0.1:${tracker.address().port}/pixel.png`;
  const planText = reader.content.getText("content");
  planText.insert(planText.length, `\n![suivi](${image})\n`);
  reader.content.commit();
  await until("the image in the note", () =>
    fileText("Plan.md")?.includes("pixel.png"),
  );
  await until("the view fetches it", () => fetched.length > 0, 10_000).catch(
    () => {},
  );
  expectThat(
    "the view's Write, Obsidian's editor, fetches an editor's remote image (the threat model's limit, phase 17, decision 14)",
    fetched.length > 0,
  );
  const fetchedByTheView = fetched.length;
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:obsidian-preview"),
  );
  const alongside = await until("the preview alongside", () =>
    page.evaluate(() =>
      app.workspace
        .getLeavesOfType("markdown")
        .map((leaf) => leaf.getViewState())
        .find((state) => state.state?.file === "Plan.md"),
    ),
  );
  expectThat(
    "Obsidian's preview alongside: the note's file, read only, beside the one view",
    alongside.state?.mode === "preview" && (await pluginViews()) === 1,
  );
  await until(
    "Obsidian's preview fetches it",
    () => fetched.length > fetchedByTheView,
    10_000,
  ).catch(() => {});
  expectThat(
    "Obsidian's preview fetches an editor's remote image (the threat model's limit)",
    fetched.length > fetchedByTheView,
  );
  await shot("preview");

  // 11. Obsidian's outline and links lead the view (phase 16, decisions
  // 9, 13): a heading clicked in the outline, a link to a heading — the
  // note open in another tab, then closed —, and a click just after an
  // edit the export doesn't have yet. The caret's line says where.
  const filler = (word) =>
    Array.from({ length: 40 }, (_, i) => `${word} ${i + 1}.`).join("\n\n");
  const third = await newDocument();
  await openLink(third.links.edit);
  outliner = await lib.openLink(third.links.edit);
  const outlined = outliner.content.getText("content");
  outlined.insert(
    0,
    `# Haut\n\n${filler("Avant")}\n\n## Milieu\n\n${filler("Pendant")}\n\n## Bas\n\n${filler("Après")}\n`,
  );
  outliner.content.commit();
  await until("the note exported", () =>
    fileText("Collab Link/Haut.md")?.includes("## Bas"),
  );
  const caretLine = () =>
    page.evaluate(() => {
      const node = document.getSelection()?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      return element?.closest(".workspace-leaf.mod-active .cm-line")
        ?.textContent;
    });
  // The note's view made the active one (Plan.md's is open too).
  const collabLeaf = () =>
    page.evaluate(() => {
      const leaf = app.workspace
        .getLeavesOfType("collab-link-document")
        .find((l) => l.view.file?.path === "Collab Link/Haut.md");
      if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
      return !!leaf;
    });
  await page.evaluate(() => app.commands.executeCommandById("outline:open"));
  await collabLeaf();
  const outlineItem = (text) =>
    `.workspace-leaf-content[data-type="outline"] .tree-item-inner:text-is("${text}")`;
  await page.waitForSelector(outlineItem("Bas"), { timeout: 10_000 });
  await page.click(outlineItem("Bas"));
  await until("the caret on Bas", async () =>
    (await caretLine())?.includes("Bas"),
  ).catch(() => {});
  expectThat(
    "a heading clicked in Obsidian's outline: the view's caret on it, in the same tab",
    !!(await caretLine())?.includes("Bas") &&
      (await activeType()) === "collab-link-document",
    await caretLine(),
  );
  await shot("outline");

  await page.evaluate(async () => {
    await app.vault.create("Renvois.md", "# Renvois\n\n[[Haut#Milieu]]\n");
    await app.workspace.getLeaf("tab").setViewState({
      type: "markdown",
      state: { file: "Renvois.md", mode: "preview" },
      active: true,
    });
  });
  const linkToMilieu =
    '.workspace-leaf.mod-active a.internal-link[data-href="Haut#Milieu"]';
  await page.waitForSelector(linkToMilieu, { timeout: 10_000 });
  await page.click(linkToMilieu);
  await until("the caret on Milieu", async () =>
    (await caretLine())?.includes("Milieu"),
  ).catch(() => {});
  expectThat(
    "a link to a heading of a note open in another tab: that tab, its caret on it (decision 13)",
    !!(await caretLine())?.includes("Milieu") &&
      (await activeType()) === "collab-link-document",
    await caretLine(),
  );

  await page.evaluate(() => {
    for (const leaf of app.workspace.getLeavesOfType("collab-link-document"))
      if (leaf.view.file?.path === "Collab Link/Haut.md") leaf.detach();
  });
  await page.evaluate(async () => {
    await app.workspace.getLeaf("tab").setViewState({
      type: "markdown",
      state: { file: "Renvois.md", mode: "preview" },
      active: true,
    });
  });
  await page.waitForSelector(linkToMilieu, { timeout: 10_000 });
  await page.click(linkToMilieu);
  await until("the caret on Milieu, once open", async () =>
    (await caretLine())?.includes("Milieu"),
  ).catch(() => {});
  expectThat(
    "a link to a heading, the note closed: opened, its caret on it",
    !!(await caretLine())?.includes("Milieu") &&
      (await activeType()) === "collab-link-document",
    await caretLine(),
  );

  // Lines added above, not exported yet: the outline still says the old
  // line; the heading is found by its text.
  outlined.insert(0, "Ajouté\n\nen haut\n\n");
  outliner.content.commit();
  await collabLeaf();
  await page.click(outlineItem("Bas"));
  await until("the caret on Bas, the export late", async () =>
    (await caretLine())?.includes("Bas"),
  ).catch(() => {});
  expectThat(
    "a heading clicked just after an edit the export lacks: found by its text",
    !!(await caretLine())?.includes("Bas"),
    await caretLine(),
  );
  // Phase 17, decision 11: what Obsidian's outline marks as the current
  // heading, our editor being its active editor. Observed, not checked.
  await sleep(1500);
  console.log(
    `seen  the outline's current heading, the caret on ${await caretLine()}: ${await page.evaluate(
      () =>
        document.querySelector(
          '.workspace-leaf-content[data-type="outline"] .tree-item-self.is-active',
        )?.textContent ?? "none",
    )}`,
  );

  // 12. Obsidian's editor in Write (phase 17): the frictions it resolves,
  // each checked (F1 to F4, F10), another's text kept by an undo
  // (decision 12), a reader's editor read only.
  const fourth = await newDocument();
  await openLink(fourth.links.edit);
  // The note alone, wide enough for the margin (over 900 px, phase 10c).
  await page.evaluate(() => {
    const kept = app.workspace.activeLeaf;
    for (const leaf of [
      ...app.workspace.getLeavesOfType("markdown"),
      ...app.workspace.getLeavesOfType("collab-link-document"),
    ]) {
      if (leaf !== kept) leaf.detach();
    }
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
  });
  await sleep(800);
  const writer = await lib.openLink(fourth.links.edit);
  const inView = (selector) =>
    page.evaluate(
      ([view, selector]) =>
        document.querySelectorAll(`${view} ${selector}`).length,
      [ACTIVE, selector],
    );
  // The view's editor, as Obsidian's commands reach it: the active
  // editor's (set when it has the focus, EH3).
  const viewEditor = (fn, arg) =>
    page.evaluate(
      ([fn, arg]) => {
        const cm = app.workspace.activeEditor?.editor?.cm;
        // A test's probe, given as text: run in the page.
        return new Function("cm", "arg", `return (${fn})(cm, arg);`)(cm, arg);
      },
      [fn, arg],
    );
  const docText = () => viewEditor("(cm) => cm?.state.doc.toString()");
  /** Types at the end of the text, the caret put there by the editor (a
   * click could land on the selection's toolbar). */
  const typeAtEnd = async (text) => {
    await viewEditor(`(cm) => {
      cm.focus();
      cm.dispatch({ selection: { anchor: cm.state.doc.length } });
    }`);
    await page.keyboard.type(text);
  };
  expectThat(
    "Write is Obsidian's editor, the only one",
    (await inView(".markdown-source-view .cm-editor")) === 1 &&
      (await inView(".cm-editor")) === 1,
  );
  await typeInView("# Titre\n\nUn mot ici.");
  await until("the typing reaches the other", () =>
    writer.content.getText("content").toString().includes("Un mot ici."),
  );
  // F10: the heading in the theme's colours.
  const heading = await page.evaluate((view) => {
    // A colour of its own, as a theme sets it.
    document.body.style.setProperty("--h1-color", "rgb(200, 30, 40)");
    const line = document.querySelector(`${view} .cm-line.HyperMD-header-1`);
    const probe = document.createElement("span");
    probe.style.color = "var(--h1-color)";
    line?.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const shown = line?.querySelector(".cm-header-1");
    const color = shown ? getComputedStyle(shown).color : null;
    document.body.style.removeProperty("--h1-color");
    return {
      found: !!line,
      expected,
      color,
    };
  }, ACTIVE);
  expectThat(
    "F10: a heading takes the theme's heading colour",
    heading.found && heading.color === "rgb(200, 30, 40)",
    JSON.stringify(heading),
  );
  // F1: Obsidian's command, and its shortcut, on the view's editor.
  await viewEditor(`(cm) => {
    const at = cm.state.doc.toString().indexOf("mot");
    cm.focus();
    cm.dispatch({ selection: { anchor: at, head: at + 3 } });
  }`);
  await page.evaluate(() =>
    app.commands.executeCommandById("editor:toggle-bold"),
  );
  await until("bold by the command", async () =>
    (await docText())?.includes("**mot**"),
  ).catch(() => {});
  expectThat(
    "F1: Obsidian's bold command acts on the view's editor",
    !!(await docText())?.includes("**mot**"),
    await docText(),
  );
  await page.keyboard.press("Control+b");
  await until(
    "bold undone by Ctrl+B",
    async () => !(await docText())?.includes("**mot**"),
  ).catch(() => {});
  expectThat(
    "F1: and its shortcut",
    !(await docText())?.includes("**mot**"),
    await docText(),
  );
  await page.keyboard.press("Control+f");
  await until(
    "the search",
    async () => (await inView(".document-search-container")) > 0,
  ).catch(() => {});
  expectThat(
    "F1: Ctrl+F opens Obsidian's search in the view",
    (await inView(".document-search-container")) > 0,
  );
  await page.keyboard.press("Escape");
  // F3: links completed from the vault.
  await typeAtEnd("\n\n[[Ren");
  await until("the link suggestions", () =>
    page.evaluate(
      () => !!document.querySelector(".suggestion-container .suggestion-item"),
    ),
  ).catch(() => {});
  const suggested = await page.evaluate(
    () => document.querySelector(".suggestion-container")?.textContent ?? "",
  );
  expectThat(
    "F3: [[ suggests the vault's notes",
    suggested.includes("Renvois"),
    suggested,
  );
  await page.keyboard.press("Escape");
  // F4: another plugin's extension, registered after the view opened
  // (decision 8).
  await viewEditor(`(cm) => {
    app.plugins.plugins["collab-link"].registerEditorExtension(
      cm.constructor.contentAttributes.of({ "data-probe": "registered-later" }),
    );
  }`);
  await until(
    "the extension in the view's editor",
    async () =>
      (await inView('.cm-content[data-probe="registered-later"]')) > 0,
  ).catch(() => {});
  expectThat(
    "F4: another plugin's editor extension, registered after the view opened, reaches it",
    (await inView('.cm-content[data-probe="registered-later"]')) > 0,
  );
  // F2: Vim, switched on in Obsidian's settings.
  await page.evaluate(() => {
    app.vault.setConfig("vimMode", true);
    app.workspace.updateOptions();
  });
  await viewEditor(`(cm) => {
    cm.focus();
    cm.dispatch({ selection: { anchor: 0 } });
  }`);
  await sleep(300);
  await page.keyboard.press("Escape");
  await page.keyboard.type("dd");
  await until(
    "dd deletes the line",
    async () => !(await docText())?.startsWith("# Titre"),
  ).catch(() => {});
  expectThat(
    "F2: Vim's dd in the view's editor",
    !(await docText())?.startsWith("# Titre"),
    await docText(),
  );
  await page.keyboard.press("u");
  await sleep(300);
  await page.evaluate(() => {
    app.vault.setConfig("vimMode", false);
    app.workspace.updateOptions();
  });
  // Decision 12: an undo takes back what was typed here, never another's.
  await typeAtEnd(" Mien.");
  const other12 = writer.content.getText("content");
  other12.insert(other12.length, " Sien.");
  writer.content.commit();
  await until("the other's text in the view", async () =>
    (await docText())?.includes("Sien."),
  );
  await page.keyboard.press("Control+z");
  await sleep(500);
  expectThat(
    "an undo takes back what was typed here, not the other's text",
    !(await docText())?.includes("Mien.") &&
      !!(await docText())?.includes("Sien."),
    await docText(),
  );
  // The page's annotations on Obsidian's editor: the selection's
  // toolbar, the mark, the card in the margin.
  await viewEditor(`(cm) => {
    const at = cm.state.doc.toString().indexOf("Sien");
    cm.focus();
    cm.dispatch({ selection: { anchor: at, head: at + 4 } });
  }`);
  await page.waitForSelector(`${ACTIVE} .selection-toolbar:not([hidden])`, {
    timeout: 10_000,
  });
  await page.click(`${ACTIVE} .selection-toolbar button`);
  await page.fill(`${ACTIVE} .selection-toolbar .composer-text`, "Vu.");
  // Sent by Ctrl+Enter, as on the web: Obsidian's keymap took it for its
  // own commands (field-keys.ts).
  await page.keyboard.press("Control+Enter");
  await until(
    "the comment's mark in Obsidian's editor",
    async () =>
      (await inView(".markdown-source-view .cm-annotation-comment")) > 0,
  ).catch(() => {});
  const marked = await page.evaluate((view) => {
    const mark = document.querySelector(
      `${view} .markdown-source-view .cm-annotation-comment`,
    );
    const card = document.querySelector(`${view} .annotation-item.card`);
    return {
      mark: mark?.textContent,
      card: card?.textContent?.includes("Vu.") ?? false,
      // The card level with its passage, in the margin (phase 10c).
      gap:
        mark && card
          ? Math.abs(
              mark.getBoundingClientRect().top -
                card.getBoundingClientRect().top,
            )
          : null,
    };
  }, ACTIVE);
  expectThat(
    "a comment from the selection's toolbar: its mark in Obsidian's editor, its card beside it",
    marked.mark === "Sien" &&
      marked.card &&
      marked.gap !== null &&
      marked.gap < 40,
    JSON.stringify(marked),
  );
  // A card's text is copied as the page's (Obsidian's body refuses a
  // selection): the card opened (in the margin, a card not chosen shows
  // its head only), its text dragged over with the mouse, selected.
  await page.click(`${ACTIVE} .annotation-item.card .card-head`);
  const cardBody = page.locator(`${ACTIVE} .annotation-item.card .card-body`);
  await cardBody.waitFor({ timeout: 10_000 });
  const box = await cardBody.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
  }
  const copied = await page.evaluate(() => String(window.getSelection()));
  expectThat(
    "a card's text, selected with the mouse, can be copied",
    copied.includes("Vu."),
    JSON.stringify(copied),
  );
  await shot("obsidian-editor");
  // A reader: Obsidian's editor, read only.
  const fifth = await newDocument();
  const filler5 = await lib.openLink(fifth.links.edit);
  const text5 = filler5.content.getText("content");
  text5.insert(0, "# Lu\n\nSeulement lu.");
  filler5.content.commit();
  // A read link opens on the preview (phase 10): the editor is there,
  // hidden until the preview is closed.
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:open-link"),
  );
  await page.fill(".modal input.collab-link-link", fifth.links.read);
  await page.click(".modal button.mod-cta");
  await page.waitForSelector(`${ACTIVE} .markdown-source-view .cm-content`, {
    state: "attached",
    timeout: 30_000,
  });
  await sleep(500);
  const readerEditor = await page.evaluate((view) => {
    const content = document.querySelector(
      `${view} .markdown-source-view .cm-content`,
    );
    // Obsidian's editor of the view, a child of the plugin: its state.
    // (contenteditable stays "true", as in the page: CodeMirror's
    // readOnly refuses the edits, it doesn't set the attribute.)
    const editor = app.plugins.plugins["collab-link"]._children?.find(
      (child) => child.cm?.contentDOM === content,
    );
    return {
      readOnly: editor?.cm.state.readOnly,
      text: content?.textContent,
      editors: document.querySelectorAll(`${view} .cm-editor`).length,
    };
  }, ACTIVE);
  expectThat(
    "a reader: Obsidian's editor, read only",
    readerEditor.readOnly === true &&
      readerEditor.editors === 1 &&
      !!readerEditor.text?.includes("Seulement lu."),
    JSON.stringify(readerEditor),
  );
  writer.close?.();
  filler5.close?.();

  // 13. Moving a section (phase 17, decision 7), by Obsidian's command,
  // while another participant's edits are on their way: typed in a fork
  // of its document before the move, received after it.
  const sixth = await newDocument();
  await openLink(sixth.links.edit);
  const mover = await lib.openLink(sixth.links.edit);
  const moverText = mover.content.getText("content");
  moverText.insert(0, "# Un\nun\n# Deux\ndeux\n");
  mover.content.commit();
  await until("the sections in the view", async () =>
    (await viewText())?.includes("deux"),
  );
  const onTheWay = mover.content.fork();
  const forked = onTheWay.getText("content");
  forked.insert(forked.toString().indexOf("deux") + 4, " (en route)");
  forked.insert("# Un\nun".length, " (voisin)");
  onTheWay.commit();
  await page.click(`${ACTIVE} .cm-content`);
  await viewEditor(`(cm) => {
    const at = cm.state.doc.toString().indexOf("deux");
    cm.dispatch({ selection: { anchor: at } });
  }`);
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:move-section-up"),
  );
  await until("the move reaches the other", () =>
    moverText.toString().startsWith("# Deux"),
  );
  const late = onTheWay.export({
    mode: "update",
    from: mover.content.oplogVersion(),
  });
  mover.content.import(late);
  mover.connection.adopt("content", late);
  await until("the late edits in the view", async () =>
    (await docText())?.includes("(en route)"),
  );
  await sleep(500);
  const afterMove = await docText();
  expectThat(
    "a section moved by Obsidian's command, another's late edits: the same text on both sides, the neighbour's in its section, the moved one's at the old place, nothing lost",
    afterMove === moverText.toString() &&
      afterMove?.startsWith("# Deux\ndeux\n# Un\nun (voisin)") &&
      afterMove.split("(en route)").length === 2 &&
      ["# Un", "# Deux", "un", "deux"].every((word) =>
        afterMove.includes(word),
      ),
    JSON.stringify(afterMove),
  );
  mover.close?.();

  // 14. « Mes documents » and the identity (phase 18m): kept in the vault,
  // signed in by the system's browser, its return by obsidian://; a note
  // then opened enters the list, and a comment reads verified, under the
  // attested name, for the plugin and for another participant.
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:my-documents"),
  );
  const HOME = ".workspace-leaf.mod-active .home";
  await page.waitForSelector(`${HOME} .home-keep`, { timeout: 30_000 });
  await page.click(`${HOME} .home-keep`);
  await page.waitForSelector(`${HOME} .home-key`, { timeout: 30_000 });
  const listKey = await page.inputValue(`${HOME} .home-key`);
  expectThat(
    "« Mes documents » kept in the vault, its key shown once",
    /^oc-keyring:v1:/.test(listKey),
    listKey.slice(0, 14),
  );
  await page.click(`${HOME} .home-kept`);
  await shot("my-documents");
  await page.waitForSelector(`${HOME} .home-sign-in:not([disabled])`, {
    timeout: 30_000,
  });
  await page.click(`${HOME} .home-sign-in`);
  const [loginAddress] = await until("the system's browser", () => {
    const sent = sentToBrowser();
    return sent.length > 0 ? sent : undefined;
  });
  const login = new URL(loginAddress);
  expectThat(
    "signing in opens the gateway in the system's browser, its return asked by obsidian:// (ID-41)",
    login.origin === GATEWAY &&
      login.pathname === "/accounts/login" &&
      login.searchParams.get("client") === "obsidian",
    loginAddress,
  );
  // The system's browser, as far as it goes: the gateway, the provider,
  // the gateway again, whose page hands it to Obsidian (analysis 18s,
  // OR1): its one link.
  let at = loginAddress;
  let returned = "";
  for (let hop = 0; hop < 10 && !at.startsWith("obsidian:"); hop++) {
    const response = await fetch(at, { redirect: "manual" });
    const next = response.headers.get("location");
    if (next) {
      at = new URL(next, at).href;
      continue;
    }
    returned = await response.text();
    const link = /href="([^"]*)"/.exec(returned)?.[1];
    if (!link) throw new Error(`no redirect from ${at}: ${response.status}`);
    at = link.replaceAll("&amp;", "&");
  }
  expectThat(
    "the gateway's page says the sign-in is done, in English (analysis 18s)",
    returned.includes("You are signed in") &&
      returned.includes("Return to Obsidian"),
    returned.slice(0, 120),
  );
  expectThat(
    "the gateway returns to obsidian://collab-link-auth, in the query",
    at.startsWith("obsidian://collab-link-auth?code=") &&
      at.includes(`&request=${login.searchParams.get("request")}`),
    at.replace(/code=[^&]+/, "code=…"),
  );
  // A forged return first (OB1): nothing.
  openInObsidian(
    `obsidian://collab-link-auth?code=${"c".repeat(43)}&request=${"0".repeat(32)}`,
  );
  await sleep(1000);
  const forged = await page.evaluate(
    (home) => !!document.querySelector(`${home} .home-signed-in`),
    HOME,
  );
  expectThat("a forged return signs no one in (OB1)", !forged);
  openInObsidian(at);
  await page.waitForSelector(`${HOME} .home-signed-in`, { timeout: 30_000 });
  const signedIn = await page.textContent(`${HOME} .home-signed-in`);
  expectThat(
    "the return by obsidian:// signs Ada in",
    !!signedIn?.includes("Ada Lovelace"),
    signedIn ?? "",
  );
  // The list associated at once (nothing to decide), the key attested.
  await until(
    "the identity confirmed",
    () =>
      page.evaluate(
        (home) =>
          !document.querySelector(`${home} .home-confirm`) &&
          !document.querySelector(`${home} .home-account-key`),
        HOME,
      ),
    30_000,
  );
  await shot("my-documents-signed-in");

  const seventh = await newDocument();
  await openLink(seventh.links.edit);
  await typeAtEnd("Le compte rendu.");
  await viewEditor(`(cm) => {
    const at = cm.state.doc.toString().indexOf("compte");
    cm.focus();
    cm.dispatch({ selection: { anchor: at, head: at + 6 } });
  }`);
  await page.waitForSelector(`${ACTIVE} .selection-toolbar:not([hidden])`, {
    timeout: 10_000,
  });
  await page.click(`${ACTIVE} .selection-toolbar button`);
  await page.fill(`${ACTIVE} .selection-toolbar .composer-text`, "Vérifié ?");
  await page.click(`${ACTIVE} .selection-toolbar .composer-actions .primary`);
  const attested = await until(
    "the comment verified in the view",
    () =>
      page.evaluate((view) => {
        const card = document.querySelector(`${view} .annotation-item`);
        return card?.querySelector(".signature.attested")
          ? card.querySelector("strong")?.textContent
          : undefined;
      }, ACTIVE),
    30_000,
  ).catch(() => undefined);
  expectThat(
    "a comment written in the plugin reads verified, under the attested name",
    attested === "Ada Lovelace",
    String(attested),
  );
  await shot("verified-comment");
  const witness = await lib.openLink(seventh.links.edit);
  await until(
    "the attestation reaches another participant",
    () => witness.annotations.getMap("attestations").size > 0,
    20_000,
  ).catch(() => {});
  expectThat(
    "another participant receives the comment's signature and attestation",
    witness.annotations.getMap("attestations").size > 0 &&
      witness.annotations.getMap("identities").size > 0,
  );
  witness.close?.();
  // The note's document in the vault's list, as a new tab of it reads it.
  await page.evaluate(async () => {
    for (const leaf of app.workspace.getLeavesOfType(
      "collab-link-my-documents",
    )) {
      await leaf.detach();
    }
    app.commands.executeCommandById("collab-link:my-documents");
  });
  const listed = await until(
    "the document in « Mes documents »",
    () =>
      page.evaluate(
        ([home, id]) =>
          !!document.querySelector(
            `${home} .home-entry[data-document="${id}"]`,
          ),
        [HOME, seventh.id],
      ),
    30_000,
  ).catch(() => false);
  expectThat("the note opened is in « Mes documents »", listed);

  // 15. Links between notes (phase 19, ADR-0045): a [[B]] completed in a
  // linked note becomes B's address; a full link pasted, its address
  // without the key; the address clicked opens B's view; a note renamed,
  // Obsidian's rewrite of the links taken as is; unlinked, the addresses
  // are names again.
  const linkB = await newDocument();
  const writerB = await lib.openLink(linkB.links.edit);
  writerB.content.getText("content").insert(0, "# B\n");
  writerB.content.commit();
  await writerB.whenPublished();
  await openLink(linkB.links.edit);
  const pathB = await page.evaluate(
    () => app.workspace.activeLeaf?.view?.file?.path,
  );
  const linkA = await newDocument();
  const writerA = await lib.openLink(linkA.links.edit);
  writerA.content.getText("content").insert(0, "# A\n\n");
  writerA.content.commit();
  await writerA.whenPublished();
  await openLink(linkA.links.edit);
  const pathA = await page.evaluate(
    () => app.workspace.activeLeaf?.view?.file?.path,
  );
  const textA = () => writerA.content.getText("content").toString();
  const addressB = `${server}/?doc=${linkB.id}`;
  // Typed, the suggestion accepted (Enter), as a person does.
  await page.click(`${ACTIVE} .cm-content`);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("[[B", { delay: 40 });
  // B's suggestion chosen, not any list: Enter while Obsidian draws the
  // list again (after `[[`, before `B`) does nothing, the caret stays in
  // the link and it isn't converted until it leaves.
  const nameB = pathB.replace(/^.*\//, "").replace(/\.md$/, "");
  await until(
    "B's suggestion chosen",
    () =>
      page.evaluate(
        (name) =>
          document
            .querySelector(".suggestion-container .suggestion-item.is-selected")
            ?.textContent?.includes(name) ?? false,
        nameB,
      ),
    10_000,
  ).catch(() => {});
  await page.keyboard.press("Enter");
  const completed = await until(
    "the link converted",
    () => textA().includes(`(${addressB})`),
    20_000,
  ).catch(() => false);
  expectThat(
    "a [[B]] completed in a linked note becomes B's address in its document",
    completed,
    textA(),
  );
  // A full link of B pasted: its address, never the key.
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" ");
  await page.evaluate(
    ([view, link]) => {
      const content = document.querySelector(`${view} .cm-content`);
      const data = new DataTransfer();
      data.setData("text/plain", link);
      content?.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [ACTIVE, linkB.links.read],
  );
  const pasted = await until(
    "the paste in the document",
    () => textA().split(addressB).length > 2,
    20_000,
  ).catch(() => false);
  const key = new URLSearchParams(new URL(linkB.links.read).hash.slice(1)).get(
    "k",
  );
  expectThat(
    "a full link pasted goes in without its key",
    pasted && !textA().includes(key ?? "#k="),
    textA(),
  );
  // The address clicked, by the mouse (Obsidian's editor opens it by
  // window.open, *Relevé 19.0*).
  const sentBefore = sentToBrowser().length;
  await page.locator(`${ACTIVE} .cm-link`, { hasText: "B" }).first().click();
  const followed = await until(
    "B's view",
    () =>
      page.evaluate(
        (path) => app.workspace.getActiveFile()?.path === path,
        pathB,
      ),
    20_000,
  ).catch(() => false);
  expectThat(
    "the address clicked opens B's view, nothing to the browser",
    followed && sentToBrowser().length === sentBefore,
    `${await page.evaluate(() => app.workspace.getActiveFile()?.path)} ${JSON.stringify(sentToBrowser().slice(sentBefore))}`,
  );
  // The click opened B in A's tab, as Obsidian opens a link: A again.
  await page.evaluate(async (path) => {
    await app.workspace
      .getLeaf("tab")
      .setViewState({ type: "markdown", state: { file: path }, active: true });
  }, pathA);
  await page.waitForSelector(`${ACTIVE} .cm-content`, { timeout: 30_000 });
  // A note renamed: Obsidian rewrites A's file; no copy, the document has it.
  await page.evaluate(async () => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    await app.vault.create("C.md", "# C\n");
  });
  writerA.content.getText("content").insert(textA().length, "\n\n[[C]]\n");
  writerA.content.commit();
  await writerA.whenPublished();
  await until(
    "A's export with [[C]]",
    () => fileText(pathA)?.includes("[[C]]"),
    20_000,
  );
  const filesBefore = await page.evaluate(
    () => app.vault.getMarkdownFiles().length,
  );
  await page.evaluate(async () => {
    await app.fileManager.renameFile(
      app.vault.getAbstractFileByPath("C.md"),
      "D.md",
    );
  });
  const renamed = await until(
    "the rewrite in the document",
    () => textA().includes("[[D]]"),
    20_000,
  ).catch(() => false);
  await sleep(1500);
  expectThat(
    "a note renamed: Obsidian's rewrite of A taken as is, no copy",
    renamed &&
      (await page.evaluate(() => app.vault.getMarkdownFiles().length)) ===
        filesBefore,
    textA(),
  );
  // Unlinked: B's address is [[B]] again, in the note.
  await page.evaluate(async (path) => {
    const leaf = app.workspace
      .getLeavesOfType("collab-link-document")
      .find((l) => l.view.file?.path === path);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    app.commands.executeCommandById("collab-link:unlink-note");
  }, pathA);
  const unlinkedText = await until(
    "A unlinked",
    () => {
      const text = fileText(pathA);
      return text && !text.includes("collab-document") ? text : undefined;
    },
    20_000,
  ).catch(() => "");
  expectThat(
    "unlinked, the addresses of the vault's notes are names again",
    unlinkedText.includes("[[B]]") &&
      unlinkedText.includes("[[D]]") &&
      !unlinkedText.includes(addressB),
    unlinkedText,
  );
  await shot("15-links");
  writerA.close?.();
  writerB.close?.();

  // 16. Attached images in the vault (ADR-0058): another client uploads
  // an image and cites it; the note opened here gets its file under
  // Collab Link/images/<document>/, its export cites the file, and
  // Obsidian's own preview of the note — no view — draws it.
  const pictured = await newDocument();
  const imageKey = await lib.importKeyFromBase64Url(
    pictured.created.keyMaterial,
  );
  const png = stripes(160, 96);
  const prepared = await lib.prepareImage(
    imageKey,
    pictured.id,
    new Uint8Array(png),
  );
  const uploaded = await lib.uploadAttachment(
    server,
    pictured.id,
    prepared.attachmentId,
    lib.roleSecretHeader("edit", pictured.created.editSecret),
    prepared.blob,
  );
  const citing = await lib.openLink(pictured.links.edit);
  const citingText = citing.content.getText("content");
  citingText.insert(
    0,
    `# Photo\n\n![un point](attachment:${prepared.attachmentId})\n`,
  );
  citing.content.commit();
  await citing.whenPublished();
  await openLink(pictured.links.edit);
  const imagePath = `Collab Link/images/${pictured.id}/${prepared.attachmentId}.png`;
  const written = await until(
    "the image's file in the vault",
    () => existsSync(join(vault, imagePath)),
    30_000,
  ).catch(() => false);
  const notePath = await page.evaluate(
    () => app.workspace.activeLeaf?.view?.file?.path,
  );
  const cited = await until(
    "the export citing the file",
    () =>
      fileText(notePath)?.includes(
        `![un point](Collab%20Link/images/${pictured.id}/${prepared.attachmentId}.png)`,
      ),
    20_000,
  ).catch(() => false);
  expectThat(
    "an attached image: uploaded, written to the vault, cited by the note's file (ADR-0058)",
    uploaded === "stored" && written && cited,
    fileText(notePath),
  );
  await page.evaluate(() =>
    app.commands.executeCommandById("collab-link:obsidian-preview"),
  );
  const drawn = await until(
    "Obsidian's preview draws it",
    () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll(
            ".workspace-leaf .markdown-reading-view img",
          ),
        ].some(
          (img) =>
            img.complete && img.naturalWidth > 0 && img.alt === "un point",
        ),
      ),
    20_000,
  ).catch(() => false);
  expectThat(
    "Obsidian's preview of the note, alone, draws the image from the vault",
    drawn,
  );
  await shot("16-vault-image");
  citing.close?.();

  // 17. Another's text comes in as written (0.6.2): Obsidian's live
  // preview renumbers an ordered list, and puts a line before a table,
  // on any change it isn't told was set from outside — another's
  // included. The editor's text then drifted from the document's: every
  // annotation, cursor and keystroke beside its place.
  const drifting = await newDocument();
  await openLink(drifting.links.edit);
  const editorText = () =>
    page.evaluate(() => app.workspace.activeEditor?.editor?.getValue());
  // Focused (the editor Obsidian's commands act on), its caret away from
  // the table, which a click could open for editing.
  await page.evaluate(
    (view) => document.querySelector(`${view} .cm-content`)?.focus(),
    ACTIVE,
  );
  const author = await lib.openLink(drifting.links.edit);
  const authored = author.content.getText("content");
  authored.insert(
    0,
    "Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n1. un\n1. deux\n1. trois\n",
  );
  author.content.commit();
  await until("the list in the view", async () =>
    (await editorText())?.includes("trois"),
  );
  // The line before the table no longer blank.
  authored.insert("Intro\n".length, "texte");
  author.content.commit();
  await until("the line before the table in the view", async () =>
    (await editorText())?.includes("texte"),
  );
  await sleep(1000);
  const shownText = await editorText();
  const asWritten = shownText === authored.toString();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("fin");
  const typedThrough = await until(
    "the typing reaches the other",
    () => authored.toString().includes("fin"),
    20_000,
  ).catch(() => false);
  await sleep(500);
  const afterTyping = await editorText();
  expectThat(
    "another's list and table come in as written; typing here lands in place (0.6.2)",
    asWritten &&
      typedThrough &&
      afterTyping === authored.toString() &&
      authored.toString().endsWith("1. trois\nfin"),
    JSON.stringify({ shownText, afterTyping, document: authored.toString() }),
  );
  await shot("17-as-written");
  author.close?.();
} catch (error) {
  expectThat("the run went through", false, String(error?.stack ?? error));
} finally {
  tracker?.close();
  other?.close?.();
  reader?.close?.();
  outliner?.close?.();
  await stop();
  await stopIdentity();
}

if (failures.length > 0) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("the plugin works end to end in Obsidian");
