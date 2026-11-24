// The page as the binary serves it (`npm run build`, `build.mjs`), with
// Svelte components compiled by esbuild-svelte (the esbuild CLI takes no
// plugins). Also run by the build test, into a directory of its own.
//
// Every file but the page has a hashed name under `assets/` (phase 9,
// SW1): a cache, HTTP or service worker, never mixes two versions, and a
// file of another version is a 404, never a wrong file.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { build } from "esbuild";
import sveltePlugin from "esbuild-svelte";

// markdown-it-texmath requires katex when it loads, though it only ever
// calls the engine the preview injects: that import resolves to an empty
// module, and KaTeX stays in the chunk loaded on demand (ADR-0021 §2).
const noKatexInTexmath = {
  name: "no-katex-in-texmath",
  setup(build) {
    build.onResolve({ filter: /^katex$/ }, (args) =>
      args.importer.includes("markdown-it-texmath")
        ? { path: "katex", namespace: "empty" }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({
      contents: "module.exports = {};",
    }));
  },
};

// Loro loads its WebAssembly by `new URL("./loro_wasm_bg.wasm",
// import.meta.url)`, which esbuild leaves as is: imported instead, the
// file is emitted with a hashed name, and the URL names it.
const LORO_WASM_URL = 'new URL("./loro_wasm_bg.wasm", import.meta.url)';
const hashedLoroWasm = {
  name: "hashed-loro-wasm",
  setup(build) {
    build.onLoad(
      { filter: /loro-crdt[\\/]browser[\\/]loro_wasm\.js$/ },
      (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!source.includes(LORO_WASM_URL)) {
          throw new Error("loro-crdt no longer loads its wasm as expected");
        }
        return {
          contents: `import loroWasmUrl from "./loro_wasm_bg.wasm";\n${source.replace(
            LORO_WASM_URL,
            "new URL(loroWasmUrl, import.meta.url)",
          )}`,
          loader: "js",
          resolveDir: dirname(args.path),
        };
      },
    );
  },
};

/** Builds the page into `outdir`; returns, relative to it, every file and
 * those opening a document loads. */
export async function buildPage({ outdir, minify = false, logLevel = "info" }) {
  rmSync(outdir, { recursive: true, force: true });
  const out = (file) => relative(outdir, file);
  const hashed = {
    outdir,
    entryNames: "assets/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    minify,
    logLevel,
    metafile: true,
  };

  // KaTeX's stylesheet and its fonts, served with the page (ADR-0021 §5);
  // the preview links the stylesheet when it first loads KaTeX.
  const quiet = logLevel === "info" ? "warning" : logLevel;
  const styles = await build({
    ...hashed,
    logLevel: quiet,
    entryPoints: ["node_modules/katex/dist/katex.min.css"],
    bundle: true,
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  });
  const katexSheet = Object.keys(styles.metafile.outputs)
    .map(out)
    .find((file) => file.endsWith(".css"));

  const { metafile } = await build({
    ...hashed,
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    // KaTeX and Pele in chunks of their own, loaded by `import()` only
    // for a text that has formulas or diagrams (ADR-0021 §6, ADR-0042).
    splitting: true,
    chunkNames: "assets/chunks/[name]-[hash]",
    loader: { ".wasm": "file", ".woff2": "file" },
    define: { KATEX_STYLESHEET: JSON.stringify(katexSheet) },
    plugins: [
      sveltePlugin({ compilerOptions: { css: "injected" } }),
      noKatexInTexmath,
      hashedLoroWasm,
    ],
    logOverride: { "large-file": "silent" },
  });

  // What opening a document loads: the entry and what it imports
  // statically. KaTeX and Pele must not be in it, nor the grammars of
  // HTML, CSS and JavaScript, which `markdown()` of lang-markdown brings
  // and the editor never shows (docs/taille-du-bundle.md, piste 1).
  const entry = Object.keys(metafile.outputs).find(
    (file) => metafile.outputs[file].entryPoint === "src/main.ts",
  );
  const opening = new Set();
  const visit = (file) => {
    if (opening.has(file)) return;
    opening.add(file);
    const { imports, cssBundle } = metafile.outputs[file];
    for (const { path, kind } of imports) {
      // A stylesheet's fonts are url-tokens (phase 10, decision 4).
      if (["import-statement", "file-loader", "url-token"].includes(kind)) {
        visit(path);
      }
    }
    if (cssBundle) visit(cssBundle);
  };
  visit(entry);
  // The page's stylesheet (phase 10): what `src/main.ts` imports.
  const sheet = metafile.outputs[entry].cssBundle;
  if (!sheet) throw new Error("src/main.ts imports no stylesheet");
  const eager = [...opening].flatMap((file) =>
    Object.keys(metafile.outputs[file]?.inputs ?? {}).filter((input) =>
      /node_modules\/(katex|pele|@codemirror\/lang-(html|css|javascript)|@lezer\/(html|css|javascript))\//.test(
        input,
      ),
    ),
  );
  if (eager.length > 0) {
    throw new Error(`loaded when opening any document: ${eager.join(", ")}`);
  }

  // The page itself (phase 9, N1): the binary serves `outdir` at its root.
  const page = readFileSync("index.html", "utf8");
  const script = '<script type="module" src="./main.js"></script>';
  if (!page.includes(script)) throw new Error("index.html: no ./main.js");
  const link = '<link rel="stylesheet" href="./main.css" />';
  if (!page.includes(link)) throw new Error("index.html: no ./main.css");
  writeFileSync(
    join(outdir, "index.html"),
    page
      .replace(script, script.replace("main.js", out(entry)))
      .replace(link, link.replace("main.css", out(sheet))),
  );

  // The page of a sign-in's return (ADR-0041, point 4): a page of its
  // own, its script apart — the gateway's return and the dictionary, not
  // the editor nor Loro.
  const returning = await build({
    ...hashed,
    logLevel: quiet,
    entryPoints: ["src/auth-return.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
  });
  const returnScript = Object.keys(returning.metafile.outputs)
    .map(out)
    .find((file) => file.endsWith(".js"));
  const returnPage = readFileSync("auth-return.html", "utf8");
  const returnTag = '<script type="module" src="./auth-return.js"></script>';
  if (!returnPage.includes(returnTag)) {
    throw new Error("auth-return.html: no ./auth-return.js");
  }
  writeFileSync(
    join(outdir, "auth-return.html"),
    returnPage.replace(
      returnTag,
      returnTag.replace("auth-return.js", returnScript),
    ),
  );

  // The service worker (phase 9, SW2), with the manifest of this version.
  const files = [
    "index.html",
    "auth-return.html",
    ...Object.keys(styles.metafile.outputs).map(out),
    ...Object.keys(metafile.outputs).map(out),
    ...Object.keys(returning.metafile.outputs).map(out),
  ].filter((file) => !file.endsWith(".map"));
  const manifest = manifestOf(
    files,
    ["index.html", ...[...opening].map(out)],
    out(entry),
    (file) => readFileSync(join(outdir, file)),
  );
  await build({
    entryPoints: ["src/sw/sw.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: join(outdir, "sw.js"),
    define: { OC_MANIFEST: JSON.stringify(manifest) },
    minify,
    logLevel: quiet,
  });
  await compressVariants(outdir, [...files, "sw.js"]);
  return { files, manifest };
}

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** Writes, next to each compressible file, its brotli and gzip variants
 * (`.br`, `.gz`), where smaller: the binary serves them by
 * `Accept-Encoding` (ADR-0049). Fonts in `woff2` or `woff` are compressed
 * already. Not in the manifest: the browser decompresses before the
 * service worker sees a response. */
async function compressVariants(outdir, files) {
  const compressible = files.filter((file) =>
    /\.(html|js|css|wasm|ttf)$/.test(file),
  );
  await Promise.all(
    compressible.flatMap((file) => {
      const bytes = readFileSync(join(outdir, file));
      const params = {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      };
      return [
        [".br", brotli(bytes, { params })],
        [".gz", gzipped(bytes, { level: 9 })],
      ].map(async ([suffix, packing]) => {
        const packed = await packing;
        if (packed.length < bytes.length) {
          writeFileSync(join(outdir, `${file}${suffix}`), packed);
        }
      });
    }),
  );
}

/** The manifest of one version (phase 9, SW2): its version is a digest of
 * every file, so that any change — the page included, whose name is fixed
 * — makes a new one. */
export function manifestOf(files, precache, entry, contents) {
  const digest = createHash("sha256");
  for (const file of [...files].sort()) {
    digest.update(file).update("\0").update(contents(file)).update("\0");
  }
  return {
    version: digest.digest("hex").slice(0, 16),
    entry,
    precache,
    files,
  };
}
