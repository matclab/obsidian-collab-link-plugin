// `npm run build [-- --minify]`: the plugin, into `dist/`, as Obsidian
// loads it (docs/phase-14-plugin-obsidian.md, decisions 7 and 12): one
// CommonJS `main.js`, Loro's WebAssembly inside it (`loro-crdt/base64`),
// and `manifest.json`. Every dependency is web/'s: `node_modules` is a
// link to `../web/node_modules`.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sveltePlugin from "esbuild-svelte";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// Obsidian's own CodeMirror (docs/phase-17-editeur-natif-obsidian.md,
// decision 3): what it gives a plugin's `require`, the very classes of its
// editor (*Relevé 17a*, EH7), so that the plugin's extensions work in it.
// Not `@lezer/markdown` nor `@codemirror/lang-markdown`, which it lacks:
// bundled, on Obsidian's modules all the same.
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

// KaTeX's sheet, for Obsidian (decisions 7 and 24): its fonts in woff2
// only, which every engine Obsidian runs on reads (the woff and ttf copies
// would triple the sheet); without its one rule outside its own classes,
// `body`'s equation counters (they start at zero all the same).
const katexForObsidian = {
  name: "katex-for-obsidian",
  setup(build) {
    build.onLoad({ filter: /katex\.min\.css$/ }, (args) => ({
      contents: readFileSync(args.path, "utf8")
        .replace(
          /,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
          "",
        )
        .replace(/body\{counter-reset:[^}]*\}/, ""),
      loader: "css",
    }));
  },
};

/** Builds the plugin into `outdir`; returns esbuild's result (of
 * `main.js`). */
export async function buildPlugin({
  outdir = here("dist"),
  minify = false,
  logLevel = "info",
} = {}) {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    entryPoints: [here("src/main.ts")],
    outfile: join(outdir, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    // Obsidian's, given to the plugin; nothing else is left to require.
    external: ["obsidian", ...OBSIDIAN_GIVES],
    alias: { "loro-crdt": "loro-crdt/base64" },
    plugins: [sveltePlugin({ compilerOptions: { css: "injected" } })],
    // KaTeX's sheet is in styles.css: nothing to link (`loadKatex`).
    define: { KATEX_STYLESHEET: JSON.stringify("") },
    minify,
    logLevel,
    metafile: true,
  });
  // The view's styles, Obsidian's `styles.css` (decisions 7, 24, 25).
  await build({
    entryPoints: [here("src/styles.css")],
    outfile: join(outdir, "styles.css"),
    bundle: true,
    loader: { ".woff2": "dataurl" },
    plugins: [katexForObsidian],
    minify,
    logLevel,
  });
  copyFileSync(here("manifest.json"), join(outdir, "manifest.json"));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPlugin({ minify: process.argv.includes("--minify") });
}
