// The plugin as Obsidian loads it (docs/phase-14-plugin-obsidian.md,
// decisions 7, 8, 12, 13): one CommonJS `main.js` and its `manifest.json`,
// nothing else to fetch; Loro's WebAssembly inside it (`loro-crdt/base64`);
// one copy of each dependency shared with the page, web/'s; Pele, every
// diagram type (ADR-0042, decision 6);
// Obsidian's CodeMirror, not a copy (phase 17, decision 3).
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { buildPlugin, sources } from "../build.mjs";

const PLUGIN = resolve(import.meta.dirname, "..");

// What Obsidian 1.14.4 gives a plugin's `require`, the very classes of its
// editor (docs/phase-17-editeur-natif-obsidian.md, *Relevé 17a*, EH7).
const OBSIDIAN_GIVES = [
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];
const WEB_MODULES = realpathSync(resolve(PLUGIN, "../web/node_modules"));

let outdir: string;
let built: Awaited<ReturnType<typeof buildPlugin>>;
let main: string;
let styles: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "collab-link-"));
  built = await buildPlugin({ outdir, logLevel: "silent" });
  main = readFileSync(join(outdir, "main.js"), "utf8");
  styles = readFileSync(join(outdir, "styles.css"), "utf8");
}, 120_000);

/** The packages bundled, by the directory they come from. */
const packages = () =>
  Object.keys(built.metafile.inputs)
    .filter((input) => input.includes("node_modules/"))
    .map((input) => {
      const real = realpathSync(resolve(PLUGIN, input));
      const [, rest = ""] = real.split(/node_modules[\\/]/);
      const parts = rest.split(/[\\/]/);
      const name = rest.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
      return { real, name: name.join("/") };
    });

describe("the plugin's build", () => {
  test("is main.js, manifest.json and styles.css, nothing else, without a warning", () => {
    expect(readdirSync(outdir).sort()).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(built.warnings).toEqual([]);
  });

  test("main.js is a CommonJS module that requires only obsidian and what Obsidian gives", () => {
    expect(main).toMatch(/module\.exports\s*=/);
    const required = new Set(
      [...main.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1]),
    );
    expect(required.has("obsidian")).toBe(true);
    expect(required.has("@codemirror/state")).toBe(true);
    expect(required.has("@codemirror/view")).toBe(true);
    expect(
      [...required].filter(
        (name) => name !== "obsidian" && !OBSIDIAN_GIVES.includes(name ?? ""),
      ),
    ).toEqual([]);
    // A module loaded later (not Loro's `import(` method): none.
    expect(main).not.toMatch(/(?<![.\w])import\(\s*["'`]/);
  });

  test("carries Loro's WebAssembly inside it, and fetches no file", () => {
    const loro = packages().filter(({ name }) => name === "loro-crdt");
    expect(loro.length).toBeGreaterThan(0);
    for (const { real } of loro)
      expect(real).toMatch(/loro-crdt[\\/]base64[\\/]/);
    expect(main).not.toContain(".wasm");
  });

  test("takes each dependency once, from web/'s node_modules", () => {
    const found = packages();
    for (const { real } of found)
      expect(real.startsWith(WEB_MODULES)).toBe(true);
    for (const name of ["svelte", "@lezer/markdown"]) {
      const roots = new Set(
        found
          .filter((input) => input.name === name)
          .map(({ real }) => real.slice(0, real.indexOf(name) + name.length)),
      );
      expect([...roots]).toHaveLength(1);
    }
  });

  test("bundles none of Obsidian's CodeMirror, but the Markdown parser it lacks (phase 17, decision 3)", () => {
    const names = new Set(packages().map(({ name }) => name));
    expect(OBSIDIAN_GIVES.filter((name) => names.has(name))).toEqual([]);
    expect(names.has("@lezer/markdown")).toBe(true);
    expect(names.has("@codemirror/lang-markdown")).toBe(true);
  });

  test("draws diagrams with Pele, every type inside it (ADR-0042, decision 6)", () => {
    // What `pele/lazy` loads on demand: each type, all in main.js.
    const lazy = join(WEB_MODULES, "pele/dist/esm/lazy.js");
    const types = [
      ...readFileSync(lazy, "utf8").matchAll(/import\("([^"]+)"\)/g),
    ].map(([, path]) => realpathSync(resolve(dirname(lazy), path ?? "")));
    expect(types.length).toBeGreaterThan(30);
    const bundled = new Set(packages().map(({ real }) => real));
    expect(types.filter((type) => !bundled.has(type))).toEqual([]);
    expect(packages().some(({ name }) => name === "mermaid")).toBe(false);
  });

  test("copies the manifest", () => {
    expect(readFileSync(join(outdir, "manifest.json"), "utf8")).toBe(
      readFileSync(join(PLUGIN, "manifest.json"), "utf8"),
    );
  });
});

/** The custom properties a CSS block declares. */
const tokens = (block: string) =>
  new Set(Array.from(block.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1] ?? ""));

// Decisions 7, 24 and 25: the page's styles, kept to the view, on
// Obsidian's theme and fonts; KaTeX with its fonts inside.
describe("the plugin's styles", () => {
  const PAGE_CSS = readFileSync(
    resolve(PLUGIN, "../web/src/styles/page.css"),
    "utf8",
  );
  const pageTokens = [
    ...tokens(PAGE_CSS.match(/:where\(\.document-view\) \{[^}]*\}/)?.[0] ?? ""),
  ].filter(
    (name) =>
      // A QR code's colours are dark on light in every theme (phase 18f):
      // not the theme's to set.
      !/^--(radius|column|text-inset|margin-width|outline-width|narrow|qr-)/.test(
        name,
      ),
  );

  test("are the page's, kept to its view; nothing else of Obsidian is touched", () => {
    expect(styles).toContain(":where(.document-view) .view-workspace");
    // Without comments, nor the fonts' long data: (scanned in linear time).
    const text = styles
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/url\([^)]*\)/g, "url()");
    const selectors = [...text.matchAll(/([^{};]+)\{/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((head) => !head.startsWith("@"))
      .flatMap((head) => head.split(/,(?![^(]*\))/).map((s) => s.trim()));
    expect(selectors.length).toBeGreaterThan(400);
    // The view's, the plugin's, and KaTeX's own classes; not even its
    // `body` counters.
    const outside = selectors.filter(
      (s) =>
        !/^(:where\(\.document-view\)|\.document-view|\.collab-link-[\w-]+|\.theme-dark \.collab-link-view|\.katex)(?![\w])/.test(
          s,
        ),
    );
    expect(outside).toEqual([]);
  });

  test("let the view's text be selected, as in the page (Obsidian's body refuses it)", () => {
    expect(styles).toMatch(
      /\.collab-link-view \.document-view \{[^}]*user-select: text/,
    );
  });

  test("redefine every color and font of the page on Obsidian's theme, light and dark alike", () => {
    const at = styles.indexOf(".collab-link-view .document-view {");
    expect(at).toBeGreaterThan(0);
    const block = styles.slice(at, styles.indexOf("}", at));
    expect(pageTokens.length).toBeGreaterThan(15);
    expect(pageTokens.filter((name) => !tokens(block).has(name))).toEqual([]);
    // Each from a variable of Obsidian's theme, which follows it to dark.
    for (const name of pageTokens) {
      const value = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1];
      expect(value, name).toMatch(/var\(--/);
    }
    expect(styles).toMatch(
      /\.theme-dark \.collab-link-view \.document-view \{[^}]*color-scheme: dark/,
    );
  });

  test("take each callout family's colour from Obsidian's own variable for it (phase 15, decision 8)", () => {
    const at = styles.indexOf(".collab-link-view .document-view {");
    const block = styles.slice(at, styles.indexOf("}", at));
    // Obsidian 1.13.7's names (*Relevé 15a*), not always the family's.
    for (const [family, obsidian] of [
      ["note", "default"],
      ["abstract", "summary"],
      ["info", "info"],
      ["todo", "todo"],
      ["tip", "tip"],
      ["success", "success"],
      ["question", "question"],
      ["warning", "warning"],
      ["failure", "fail"],
      ["danger", "error"],
      ["bug", "bug"],
      ["example", "example"],
      ["quote", "quote"],
    ]) {
      const value = block.match(
        new RegExp(`--md-callout-${family}\\s*:\\s*([^;]+);`),
      )?.[1];
      expect(value, family).toMatch(
        new RegExp(`var\\(--callout-${obsidian}\\)`),
      );
    }
  });

  test("highlight as Obsidian does: the theme's highlight, else Obsidian's yellow (ADR-0044; 1.14.5 defines no --text-highlight-bg)", () => {
    const at = styles.indexOf(".collab-link-view .document-view {");
    const block = styles.slice(at, styles.indexOf("}", at));
    expect(block).toMatch(
      /--md-highlight\s*:\s*var\(\s*--text-highlight-bg,\s*var\(--highlight-background-yellow\)\s*\);/,
    );
  });

  test("write a callout's title in the text's colour,its icon and tint in the theme's: AA whatever the theme (phase 15, essai 15e.2)", () => {
    const at = styles.indexOf(".collab-link-view .document-view {");
    const block = styles.slice(at, styles.indexOf("}", at));
    expect(block).toMatch(/--md-callout-title\s*:\s*var\(--text-normal\)/);
    expect(styles).toMatch(
      /\.md-callout-title\s*\{[^}]*color:\s*var\(--md-callout-title,\s*var\(--md-callout\)\)/,
    );
  });

  test("use Obsidian's fonts, not the page's reading font (decision 25)", () => {
    expect(styles).not.toMatch(/@font-face\s*\{[^}]*Literata/);
    expect(styles).not.toMatch(/literata[^)]*\.woff2/i);
  });

  test("carry KaTeX's fonts inside, woff2 only, and fetch no file", () => {
    expect(styles).toContain(".katex");
    const fonts = styles.match(/url\(["']?data:font\/woff2;base64,/g) ?? [];
    expect(fonts.length).toBe(20);
    expect(styles).not.toMatch(/url\((?!["']?data:)/);
    expect(styles).not.toMatch(
      /\.woff\b|\.ttf\b|format\(["']?(woff|truetype)["']?\)/,
    );
  });

  test("leave main.js loading no KaTeX sheet: it is in styles.css", () => {
    expect(main).not.toContain("katex.min.css");
  });
});

// The plugin's GitHub repository holds these, not the whole page
// (scripts/plugin-mirror.mjs, docs/phase-41-lint-de-l-annuaire-obsidian.md):
// what Obsidian's directory reads and builds is the plugin's source.
describe("the plugin's sources", () => {
  let found: string[];
  beforeAll(async () => {
    found = await sources();
  }, 120_000);

  test("are what its build reads, JavaScript and styles, from the repository's root", () => {
    expect(found).toContain("obsidian/src/main.ts");
    expect(found).toContain("web/src/embed.ts");
    expect(found).toContain("web/lib/src/index.ts");
    expect(found).toContain("web/src/styles/page.css");
    expect(found.some((path) => path.endsWith(".svelte"))).toBe(true);
  });

  test("leave out the page's own, and the dependencies", () => {
    expect(found).not.toContain("web/src/main.ts");
    expect(found.filter((path) => path.includes("node_modules"))).toEqual([]);
  });
});
