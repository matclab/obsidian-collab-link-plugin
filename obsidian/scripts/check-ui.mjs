// Checks the plugin's view in the real Obsidian (docs/phase-14-plugin-
// obsidian.md, 14f.3), as `web/scripts/ui/check.mjs` checks the page: for
// each theme of Obsidian, each width of the view (narrow, wide), each role
// and each mode, axe-core on the view's element alone (Obsidian's own
// interface is not ours to judge), no horizontal scroll in the view, its
// header against the tab's top edge (nothing scrolls above it), the caret
// visible; a screenshot of each. Against the real server, on a
// document annotated through the view's selection toolbar. « Mes
// documents » too (phase 18m): without a list, its key shown once, and
// the list, in each theme, wide and narrow.
//
// It sets everything up and takes it down (`harness.mjs`): the plugin in
// a throwaway vault, the server and Obsidian under Xvfb, stopped by their
// process group — never `pkill -f`.
//
//   (cd ../server && cargo build -p app)
//   node scripts/check-ui.mjs [--shots dir] [--keep]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, sleep, startObsidian, until } from "./harness.mjs";

const options = { shots: "", keep: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--shots") options.shots = process.argv[++i] ?? "";
  else if (arg === "--keep") options.keep = true;
  else throw new Error(`unknown option ${arg}`);
}
const axe = readFileSync(
  join(ROOT, "web/node_modules/axe-core/axe.min.js"),
  "utf8",
);

const TEXT =
  "---\ntags: [réunion, projet]\n---\n# Compte rendu\n\n## Décisions\n\nLa phase 9 est terminée, et le fuzzing n'a trouvé aucun plantage restant.\n\nNous publierons la version 1.0 à la fin du mois, après une semaine de tests.\n\n- Rendre l'interface bilingue.\n- Choisir une police de lecture.\n\n| Tâche | Qui |\n|---|---|\n| Prototype | Mathieu |\n\n" +
  "- [ ] Relire ==le texte==.\n- [x] Écrire le plan.\n\n> Une citation, avec un [lien](https://example.org).\n\n" +
  // Links (phase 19): to a heading, to a note not shared, to a document.
  "Vers [[#Décisions]], une note non partagée [[Brouillon]] et [un document](https://example.org/?doc=d).\n\n" +
  "Une formule $E = mc^2$ et un bloc :\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n" +
  "```\nconst x = 1;\n```\n\n" +
  "> [!warning] Attention, un *titre*\n> Le contenu, avec un [lien](https://example.org).\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n" +
  "> [!tip]-\n> Replié dans l'aperçu.\n\n" +
  "> [!faq]+ Une question\n> > [!bug] Imbriqué\n> > texte\n";

// An annotation's text in Markdown (ADR-0047): a list, a highlight, a
// link, inline code, and a code block whose line is wider than any card.
const RICH_COMMENT =
  "Détail technique ?\n\n- voir la **note de sécurité**\n- ==🟡à vérifier== avec `run.sh`\n\n> une citation du texte\n\n[Le guide](https://rust-fuzz.github.io/book/)\n\n```sh\nserver/fuzz/run.sh 1800 relay parse_client_message decode_frame parse_create_document\n```";

const port = 18000 + Math.floor(Math.random() * 900);
const {
  page,
  lib,
  server: SERVER,
  stop,
} = await startObsidian({
  preferences: { "obsidian-collab:pseudonym": "Mathieu" },
  // « Mes documents » keeps the vault's list on this server (18m, M1).
  settings: { server: `http://127.0.0.1:${port}` },
  keep: options.keep,
  port,
});
if (options.shots) mkdirSync(options.shots, { recursive: true });
const problems = [];
let checked = 0;

try {
  const created = await lib.createDocument(SERVER);
  const links = await lib.documentLinks(
    `${SERVER}/`,
    created.documentId,
    created.keyMaterial,
    created.editSecret,
  );
  page.on("pageerror", (error) =>
    problems.push(`page error: ${error.message}`),
  );
  await page.evaluate(() => app.workspace.leftSplit.collapse());

  const VIEW = ".workspace-leaf.mod-active .collab-link-view";
  const at = (selector) => `${VIEW} ${selector}`;

  /** "Open a link": a note of its own, in the view. */
  async function openLink(link) {
    await page.evaluate(() =>
      app.commands.executeCommandById("collab-link:open-link"),
    );
    await page.fill(".modal input.collab-link-link", link);
    await page.click(".modal button.mod-cta");
    // Attached: a read link may open on the page's preview.
    await page.waitForSelector(at(".cm-content"), {
      state: "attached",
      timeout: 30_000,
    });
    await sleep(800);
    return page.evaluate(() => app.workspace.activeLeaf?.id);
  }

  async function selectWord(word) {
    // In a block Obsidian's editor draws (a callout, phase 15), the word
    // is in no text line: selected through the editor, Obsidian's active
    // one (phase 17), its source then shown.
    const drawn = await page.evaluate(
      ([view, w]) =>
        ![...document.querySelectorAll(`${view} .cm-line`)].some((line) =>
          line.textContent.includes(w),
        ),
      [VIEW, word],
    );
    if (drawn) {
      const selected = await page.evaluate((w) => {
        const cm = app.workspace.activeEditor?.editor?.cm;
        const at = cm?.state.doc.toString().indexOf(w) ?? -1;
        if (!cm || at < 0) return false;
        cm.focus();
        // As the user's: after an annotation, the toolbar waits for one.
        cm.dispatch({
          selection: { anchor: at, head: at + w.length },
          scrollIntoView: true,
          userEvent: "select",
        });
        return true;
      }, word);
      if (!selected) throw new Error(`no ${word}`);
      // Once scrolled to it, the same selection again: the toolbar is
      // placed where the word is now.
      await sleep(500);
      await page.evaluate(() => {
        const cm = app.workspace.activeEditor?.editor?.cm;
        if (cm)
          cm.dispatch({ selection: cm.state.selection, userEvent: "select" });
      });
      await page.waitForSelector(at(".selection-toolbar:not([hidden])"), {
        timeout: 10_000,
      });
      await sleep(200);
      return;
    }
    const point = await page.evaluate(
      ([view, w]) => {
        for (const line of document.querySelectorAll(`${view} .cm-line`)) {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent.indexOf(w);
            if (i < 0) continue;
            // In sight: after typing, the end of the text is.
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
  }

  /** Through the toolbar: comment (0), suggest (1), delete (2). */
  async function annotate(word, which, text) {
    await selectWord(word);
    await page.locator(at(".selection-toolbar > button")).nth(which).click();
    await page.fill(
      at(which === 2 ? ".composer-note" : ".composer-text"),
      text,
    );
    await page.locator(at(".selection-toolbar .primary")).click();
    await sleep(300);
  }

  // The document, written and annotated by its editor, in the view.
  const leaves = { edit: await openLink(links.edit) };
  await page.click(at(".cm-content"));
  await page.keyboard.insertText(TEXT);
  await sleep(500);
  await annotate("fuzzing", 0, RICH_COMMENT);
  await annotate("semaine", 1, "deux semaines");
  await annotate("restant", 2, "Inutile ici.");
  // In a callout folded in the preview (phase 15).
  await annotate("Replié", 0, "Dans un callout.");
  // On a plain quote's text, grey: under the comment's tint, it must
  // still read (3.81:1 in Obsidian's dark theme, before).
  await annotate("citation", 0, "Sur une citation.");
  // Closed (ADR-0052): under « Closes », with the text it covers.
  await page
    .locator(at(".annotations-list .annotation-item"), {
      hasText: "Sur une citation.",
    })
    .click();
  await page.locator(at(".annotation-item.active .action-resolve")).click();
  await sleep(800);
  leaves.suggest = await openLink(links.suggest);
  leaves.read = await openLink(links.read);

  /** The view shown: its leaf made active. */
  async function show(role) {
    await page.evaluate((id) => {
      const leaf = app.workspace.getLeafById(id);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, leaves[role]);
    await sleep(400);
  }

  async function setTheme(theme) {
    await page.evaluate(
      (name) => app.changeTheme(name === "dark" ? "obsidian" : "moonstone"),
      theme,
    );
    await until(`theme ${theme}`, () =>
      page.evaluate(
        (name) => document.body.classList.contains(`theme-${name}`),
        theme,
      ),
    );
    await sleep(300);
  }

  /** The caret against the editor's background (WCAG ratio). */
  const caretContrast = () =>
    page.evaluate((view) => {
      // `rgb(r g b)` in 0–255, or `color(srgb r g b)` in 0–1 (color-mix).
      const rgb = (c) => {
        const values = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        return c.startsWith("color(srgb") ? values.map((v) => v * 255) : values;
      };
      const luminance = ([r, g, b]) => {
        const c = [r, g, b].map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const content = document.querySelector(`${view} .cm-content`);
      if (!content) return 0;
      const caretColor = getComputedStyle(content).caretColor;
      // The first background drawn under it (Obsidian's editor has none).
      let paperColor = "rgb(255, 255, 255)";
      for (let at = content; at; at = at.parentElement) {
        const color = getComputedStyle(at).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
          paperColor = color;
          break;
        }
      }
      const caret = luminance(rgb(caretColor));
      const paper = luminance(rgb(paperColor));
      const ratio =
        (Math.max(caret, paper) + 0.05) / (Math.min(caret, paper) + 0.05);
      return { ratio, colors: `${caretColor} on ${paperColor}` };
    }, VIEW);

  /** Who wrote (ADR-0059 §4): each person's tint against each text colour
   * of the view, each line against the background, in the view's own
   * tokens — the check of the views sees only the first person's. */
  const authorContrasts = () =>
    page.evaluate((view) => {
      const root = document.querySelector(`${view} .document-view`);
      if (!root) return ["no view"];
      const rgb = (c) => {
        const values = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        return c.startsWith("color(srgb") ? values.map((v) => v * 255) : values;
      };
      const luminance = ([r, g, b]) => {
        const c = [r, g, b].map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const ratio = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const probe = (property, value) => {
        const span = document.createElement("span");
        span.style[property] = value;
        root.append(span);
        const color = getComputedStyle(span)[property];
        span.remove();
        return rgb(color);
      };
      const paper = probe("backgroundColor", "var(--paper)");
      const found = [];
      for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "unknown"]) {
        const tint = probe("backgroundColor", `var(--author-${n})`);
        for (const text of ["--ink", "--muted", "--ins", "--del", "--pencil"]) {
          const r = ratio(probe("color", `var(${text})`), tint);
          if (r < 4.5) found.push(`${text} on --author-${n}: ${r.toFixed(2)}`);
        }
        const r = ratio(probe("color", `var(--author-${n}-line)`), paper);
        if (r < 3) found.push(`--author-${n}-line: ${r.toFixed(2)}`);
      }
      return found;
    }, VIEW);

  async function check(label) {
    checked++;
    const overflow = await page.evaluate((view) => {
      const pane = document.querySelector(view);
      const root = pane?.querySelector(".document-view");
      return Math.max(
        (pane?.scrollWidth ?? 0) - (pane?.clientWidth ?? 0),
        (root?.scrollWidth ?? 0) - (root?.clientWidth ?? 0),
      );
    }, VIEW);
    if (overflow > 0)
      problems.push(`${label}: ${overflow}px of horizontal scroll`);
    // The header sticks to the tab's edge, not under its padding: the text
    // would scroll in the gap above it.
    const gap = await page.evaluate((view) => {
      const pane = document.querySelector(view);
      const bar = pane?.querySelector(".view-topbar");
      if (!pane || !bar) return 0;
      return (
        bar.getBoundingClientRect().top -
        pane.getBoundingClientRect().top -
        pane.clientTop
      );
    }, VIEW);
    if (Math.abs(gap) > 0.5)
      problems.push(`${label}: ${gap}px above the header`);
    // In History, its versions on screen: Obsidian's editor's element,
    // left over the history, put them far below an empty screen.
    if (label.endsWith("-history")) {
      const top = await page.evaluate((view) => {
        const entry = document.querySelector(`${view} .history-entry`);
        return entry ? entry.getBoundingClientRect().top : null;
      }, VIEW);
      const height = page.viewportSize()?.height ?? 900;
      if (top === null || top > height)
        problems.push(`${label}: the versions are off screen (${top}px)`);
    }
    await page.evaluate(axe);
    const violations = await page.evaluate(async (view) => {
      const result = await window.axe.run(document.querySelector(view), {
        // The nodes themselves, to tell Obsidian's (decisions 15, 16).
        elementRef: true,
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      });
      // Phase 17, decisions 15 and 16: what Obsidian draws in its editor,
      // as in any of its notes — its task checkboxes without a label, its
      // callouts' titles in their colours, its links' names, an unresolved
      // link's faded colour (phase 19: a `[[…]]` to a note not in this
      // vault) —; its markup,
      // not the view's. Those rules, on those nodes only, in Obsidian's
      // editor only.
      const obsidians = {
        label: (element) => element.matches(".task-list-item-checkbox"),
        "color-contrast": (element) =>
          !!element.closest(".callout-title, .is-unresolved"),
        "label-content-name-mismatch": (element) => element.matches("a"),
      };
      for (const violation of result.violations) {
        const drawn = obsidians[violation.id];
        if (!drawn) continue;
        violation.nodes = violation.nodes.filter(
          (node) =>
            !(
              node.element?.closest(".markdown-source-view") &&
              drawn(node.element)
            ),
        );
      }
      return result.violations
        .filter((v) => v.nodes.length > 0)
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map(
          (v) =>
            `${v.id} (${v.impact}): ${v.nodes
              .slice(0, 3)
              .map((n) => {
                // A contrast: its colours and ratio, to fix it.
                const d = n.any[0]?.data;
                const ratio = d?.contrastRatio
                  ? ` [${d.fgColor} on ${d.bgColor}: ${d.contrastRatio}]`
                  : "";
                return `${n.target.join(" ")}${ratio}`;
              })
              .join(", ")}`,
        );
    }, VIEW);
    for (const violation of violations) problems.push(`${label}: ${violation}`);
    if (options.shots) {
      await page.screenshot({
        path: join(options.shots, `${label.replace(/[^\w-]+/g, "-")}.png`),
      });
    }
  }

  const click = async (selector) => {
    await page.locator(at(selector)).first().click();
    await sleep(400);
  };
  const visible = (selector) => page.locator(at(selector)).first().isVisible();
  /** The view chosen in Write (ADR-0064, AC8), to come back to it. */
  const viewShown = () =>
    page
      .locator(at(".view-choice [aria-pressed='true']"))
      .first()
      .getAttribute("class")
      .then((c) => c?.split(" ").find((name) => name.endsWith("-toggle")));

  // Both editors (phase 17): Obsidian's, then the page's (its setting,
  // decision 5); the views opened again for each.
  for (const editor of ["obsidian", "page"]) {
    if (editor === "page") {
      await page.evaluate(async () => {
        const plugin = app.plugins.plugins["collab-link"];
        plugin.storage.setSetting("editor", "page");
        await plugin.settled();
        for (const leaf of app.workspace.getLeavesOfType(
          "collab-link-document",
        ))
          leaf.detach();
      });
      await sleep(500);
      leaves.edit = await openLink(links.edit);
      leaves.suggest = await openLink(links.suggest);
      leaves.read = await openLink(links.read);
    }
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      // Wide: Obsidian's window at 1440 px, its side panel folded (the view
      // ~1360 px); narrow: at 480 px (the view under 900 px, decision 26).
      for (const width of [1440, 480]) {
        await page.setViewportSize({ width, height: 900 });
        await sleep(500);
        for (const role of ["edit", "suggest", "read"]) {
          await show(role);
          if (width === 1440 && role === "edit") {
            for (const found of await authorContrasts())
              problems.push(`${editor}-${theme}: who wrote, ${found}`);
          }
          const label = `${editor}-${theme}-${role}-${width}`;
          await check(`${label}-write`);
          if (role === "edit") {
            // The selection's toolbar on the theme: not in the ink's
            // colour (it was white on a dark theme).
            await selectWord("semaine");
            await check(`${label}-toolbar`);
            const toolbar = await page.evaluate((view) => {
              const bar = document.querySelector(
                `${view} .selection-toolbar:not([hidden])`,
              );
              const root = document.querySelector(`${view} .document-view`);
              return bar && root
                ? {
                    bar: getComputedStyle(bar).backgroundColor,
                    ink: getComputedStyle(root).color,
                  }
                : null;
            }, VIEW);
            if (!toolbar) problems.push(`${label}: no selection toolbar`);
            else if (toolbar.bar === toolbar.ink)
              problems.push(`${label}: the toolbar is in the ink's colour`);
            await page.keyboard.press("Escape");
            await sleep(200);
            const { ratio, colors } = await caretContrast();
            if (ratio < 3) {
              problems.push(
                `${label}: the caret's contrast is ${ratio.toFixed(2)} (${colors}), under 3`,
              );
            }
          }
          if (await visible(".source-toggle")) {
            const was = await viewShown();
            await click(".source-toggle");
            await check(`${label}-source`);
            if (was) await click(`.${was}`);
          }
          // Who wrote (ADR-0059): on, the text tinted in Obsidian's editor
          // and the legend over it; the preview's bars; off again.
          if (await visible(".authorship-toggle")) {
            await click(".authorship-toggle");
            if (!(await visible(".authorship-legend:not([hidden])")))
              problems.push(`${label}: no legend once "who wrote" is on`);
            if (!(await visible(".cm-author")))
              problems.push(`${label}: no text tinted once "who wrote" is on`);
            // ADR-0061: each person's text underlined, dotted, in their
            // line; under a highlight, the highlight's background shows.
            // Obsidian's editor puts its highlight around the mark, the
            // page's inside it: either way, no tint over the highlight.
            const marks = await page.evaluate((view) => {
              const mark = document.querySelector(`${view} .cm-author`);
              const lit = document.querySelector(
                `${view} :is(.cm-highlight, .cm-md-highlight)`,
              );
              const inner = lit?.querySelector(".cm-author");
              return {
                style: mark && getComputedStyle(mark).textDecorationStyle,
                lit: lit && getComputedStyle(lit).backgroundColor,
                inner: inner
                  ? getComputedStyle(inner).backgroundColor
                  : "rgba(0, 0, 0, 0)",
              };
            }, VIEW);
            if (marks.style !== "dotted")
              problems.push(
                `${label}: who wrote's underline is ${marks.style}`,
              );
            if (marks.lit === null || marks.lit === "rgba(0, 0, 0, 0)")
              problems.push(`${label}: no highlight under who wrote`);
            if (marks.inner !== "rgba(0, 0, 0, 0)")
              problems.push(
                `${label}: a person's tint (${marks.inner}) covers the highlight`,
              );
            await check(`${label}-who-wrote`);
            if (await visible(".preview-toggle")) {
              const was = await viewShown();
              await click(".preview-toggle");
              if (!(await visible(".preview.authorship-on > [data-authors]")))
                problems.push(`${label}: no bar in the preview`);
              await check(`${label}-who-wrote-preview`);
              if (was) await click(`.${was}`);
            }
            await click(".authorship-toggle");
          }
          if (
            width === 1440 &&
            (await visible(".layout-margin .annotation-item"))
          ) {
            await click(".layout-margin .annotation-item");
            await check(`${label}-margin`);
            await page.keyboard.press("Escape");
          }
          if (width === 1440 && (await visible(".annotations-filter"))) {
            await click('.annotations-filter [data-filter="closed"]');
            if (await visible(".closed-list .see-text")) {
              await click(".closed-list .see-text");
              // By its marked text, in the margin (ADR-0053).
              if (!(await visible(".open-list .see-text[aria-expanded=true]")))
                problems.push(
                  `${label}: the closed card shown is not in the margin`,
                );
              if (!(await visible(".cm-located, .cm-located-point")))
                problems.push(`${label}: the closed card's text is not marked`);
              await check(`${label}-closed`);
              await click(".open-list .see-text[aria-expanded=true]");
              if (await visible(".cm-located, .cm-located-point"))
                problems.push(
                  `${label}: the mark stays once the text is hidden`,
                );
            } else {
              problems.push(`${label}: no closed card under « Closes »`);
              await check(`${label}-closed`);
            }
            await click('.annotations-filter [data-filter="open"]');
          }
          // Side by side, in Source (ADR-0064, AC9).
          if (width === 1440 && (await visible(".source-toggle"))) {
            const was = await viewShown();
            await click(".source-toggle");
            if (await visible(".side-toggle")) {
              await click(".side-toggle");
              await check(`${label}-side`);
              await click(".side-toggle");
            }
            if (was) await click(`.${was}`);
          }
          if (await visible(".preview-toggle")) {
            const was = await viewShown();
            await click(".preview-toggle");
            await check(`${label}-preview`);
            if (was) await click(`.${was}`);
          }
          const modes = page.locator(at(".modes button"));
          await modes.nth(1).click();
          await sleep(400);
          await check(`${label}-review`);
          await modes.nth(2).click();
          await sleep(400);
          // Before a version is chosen: what one can do with one.
          await check(`${label}-versions`);
          await click(".history-entry");
          await check(`${label}-history`);
          await modes.nth(0).click();
          await sleep(300);
          if (role === "edit") {
            await click(".share-button");
            await check(`${label}-share`);
            await page.keyboard.press("Escape");
            await sleep(200);
          }
          await click(".document-button");
          await check(`${label}-document`);
          await page.keyboard.press("Escape");
          await sleep(200);
        }
      }
    }
  }

  // Phase 18m: « Mes documents », the page's home in a tab of the plugin.
  const myDocuments = async () => {
    await page.evaluate(async () => {
      for (const leaf of app.workspace.getLeavesOfType(
        "collab-link-my-documents",
      )) {
        await leaf.detach();
      }
      app.commands.executeCommandById("collab-link:my-documents");
    });
    await page.waitForSelector(at(".home"), { timeout: 30_000 });
    await sleep(500);
  };
  await setTheme("light");
  await page.setViewportSize({ width: 1440, height: 900 });
  await myDocuments();
  await check("my-documents-light-none-1440");
  await click(".home-keep");
  await page.waitForSelector(at(".home-key"), { timeout: 30_000 });
  await check("my-documents-light-key-1440");
  await click(".home-kept");
  // A note opened now enters the list.
  const listed = await lib.createDocument(SERVER);
  await openLink(
    (
      await lib.documentLinks(
        `${SERVER}/`,
        listed.documentId,
        listed.keyMaterial,
        listed.editSecret,
      )
    ).edit,
  );
  await myDocuments();
  await page.waitForSelector(at(".home-entry"), { timeout: 30_000 });
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    for (const width of [1440, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(300);
      await check(`my-documents-${theme}-list-${width}`);
    }
  }
} finally {
  await stop();
}

console.log(`${checked} views checked in Obsidian`);
if (problems.length > 0) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log(
  "no serious or critical violation, no horizontal scroll, no gap above the header",
);
