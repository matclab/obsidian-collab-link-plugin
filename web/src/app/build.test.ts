// @vitest-environment node
//
// The page as a release builds it (`npm run build -- --minify`, phase 9,
// SW1): every file but the
// page itself (and its service worker) has a hashed name under `assets/`,
// so that a cache — HTTP or service worker — can never mix two versions,
// and what a file references exists.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const HASHED =
  /^assets\/(chunks\/)?[^/]+-[A-Z0-9]{8}\.(js|css|wasm|woff2?|ttf)$/;
/** The budget of the JavaScript opening a document loads, in gzip bytes.
 * 364 KiB since phase 29 (ADR-0055): the remote images' grants, case and
 * banner, 2.9 KB, past the 0.8 KB left; 365 KiB since 0.5.3's fixes: the
 * active annotation chosen again (its passage brought back), 62 bytes
 * past what was left; 368 KiB since phase 31e (ADR-0057): showing the
 * attached images — their formats, decryption, the view's service, the
 * editor's widget —, 1.9 KB past what was left; 371 KiB since 31f:
 * inserting one — the catalogue's entry, the upload, the metadata
 * stripped —, 3.4 KB, in the bundle: loaded on demand, it split the
 * library into a chunk the opening loads anyway, heavier in all; 372 KiB
 * with its export as a .zip (the writer, the references rewritten), 0.3 KB
 * past; 373 KiB since a failed upload says the server's answer (a 413 of
 * a proxy, a 500), not that it can't be reached, 50 bytes past; 376 KiB
 * with "who wrote" (ADR-0059: the editor's marks, the legend, the names'
 * index), 2.7 KB, under the 20 KB that would load it on demand; 377 KiB
 * with its bars in the preview, 0.5 KB; 379 KiB with the alerts of what
 * awaits my reply (ADR-0060 §1: what to alert of, the notification, the
 * offer in the document menu), 1.5 KB; 381 KiB with the round of « Mes
 * documents » (§2: a copy read, caught up, counted), 1 KB; 385 KiB with
 * Web Push (§3 – §5: the notifier, RFC 8291's encryption, the
 * subscriptions, this device's), 3.7 KB, under the 20 KB that would load
 * it on demand; 386 KiB once rebased on 0.7.0 (its fixes of the outline,
 * the margin and the selection over a callout), 0.1 KB over; 388 KiB
 * with the invitation to be notified (phase 34j: its banner, the state
 * shared with the menu), 1 KB over 386 KiB; 389 KiB with the outline's
 * handle (ADR-0062 §1: its width, by the pointer and the keys, kept), 62
 * bytes past; 390 KiB with its folding (PV4 to PV8: the tree, the
 * chevrons, « Levels »), 0.5 KB past; 391 KiB with a double or triple
 * click on what was seen (multi-click.ts: CodeMirror's mouse selection
 * from the first press), 0.5 KB past; 392 KiB with a callout's families
 * in the / menu (ADR-0063: their names in both languages, the filter),
 * 0.5 KB past; 393 KiB with the first visit's banner (ADR-0064, AC1: its
 * texts in both languages, its component), 0.8 KB past; 394 KiB with the
 * first hints (ADR-0064, AC4 - AC7: their state in the editor, their
 * texts), 0.85 KB past; 395 KiB with the views as one control (ADR-0064,
 * AC8 - AC10: three buttons, the help named), 72 bytes past; 396 KiB
 * with the home in four modules (phase 38d: what they share passed as
 * `HomeCore`, nothing added), 0.2 KB past. */
const INITIAL_JS_GZIP_BUDGET = 396 * 1024;
/** A file's compressed variants (ADR-0049), next to it. */
const VARIANT = /\.(br|gz)$/;
const COMPRESSIBLE = /\.(html|js|css|wasm|ttf)$/;

let outdir: string;
/** Every file written, variants included; `files` without them. */
let all: string[];
let files: string[];
let manifest: {
  version: string;
  entry: string;
  precache: string[];
  files: string[];
};
const read = (file: string) => readFileSync(join(outdir, file), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [relative(outdir, join(dir, entry.name))],
  );
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), "oc-build-"));
  // @ts-expect-error: plain JavaScript, without types.
  const { buildPage } = await import("../../build-page.mjs");
  ({ manifest } = await buildPage({
    outdir,
    minify: true,
    logLevel: "error",
  }));
  all = walk(outdir).sort();
  files = all.filter((file) => !VARIANT.test(file));
}, 60_000);

afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe("the built page", () => {
  test("only the page and its service worker have fixed names; everything else is hashed, under assets/", () => {
    const fixed = files.filter((file) => !HASHED.test(file));
    expect(fixed).toEqual(["auth-return.html", "index.html", "sw.js"]);
  });

  test("the return of a sign-in loads its own hashed script, without Loro (ADR-0041)", () => {
    const [, src] =
      read("auth-return.html").match(
        /<script type="module" src="\.\/([^"]+)"/,
      ) ?? [];
    expect(src).toMatch(/^assets\/auth-return-[A-Z0-9]{8}\.js$/);
    expect(files).toContain(src);
    expect(manifest.files).toContain("auth-return.html");
    expect(manifest.files).toContain(src);
    const script = read(src as string);
    expect(script).not.toMatch(/loro/i);
    expect(script.length).toBeLessThan(100_000);
  });

  test("the page loads its hashed bundle, which exists", () => {
    const [, src] =
      read("index.html").match(/<script type="module" src="\.\/([^"]+)"/) ?? [];
    expect(src).toMatch(/^assets\/main-[A-Z0-9]{8}\.js$/);
    expect(files).toContain(src);
  });

  test("the page loads its hashed stylesheet, which exists and is precached", () => {
    const [, href] =
      read("index.html").match(/<link rel="stylesheet" href="\.\/([^"]+)"/) ??
      [];
    expect(href).toMatch(/^assets\/main-[A-Z0-9]{8}\.css$/);
    expect(files).toContain(href);
    expect(manifest.precache).toContain(href);
  });

  test("the reading font is served with the page and precached: Literata, Latin, roman and italic only", () => {
    const fonts = files.filter((file) => /literata/i.test(file));
    expect(fonts.map((file) => file.replace(/-[A-Z0-9]{8}\./, "."))).toEqual([
      "assets/literata-latin-wght-italic.woff2",
      "assets/literata-latin-wght-normal.woff2",
    ]);
    for (const font of fonts) expect(manifest.precache).toContain(font);
  });

  test("the bundle loads Loro's WebAssembly by its hashed name", () => {
    const main = files.find((file) =>
      /^assets\/main-[A-Z0-9]{8}\.js$/.test(file),
    ) as string;
    const [, wasm] =
      read(main).match(/"\.\/(loro_wasm_bg-[A-Z0-9]{8}\.wasm)"/) ?? [];
    expect(wasm).toBeDefined();
    expect(files).toContain(`assets/${wasm}`);
    expect(read(main)).not.toContain('"./loro_wasm_bg.wasm"');
  });

  test("KaTeX's stylesheet, named in the bundle, and every font it references exist", () => {
    const main = files.find((file) =>
      /^assets\/main-[A-Z0-9]{8}\.js$/.test(file),
    ) as string;
    const sheets = files.filter((file) =>
      /^assets\/katex\.min-[A-Z0-9]{8}\.css$/.test(file),
    );
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0] as string;
    expect(read(main)).toContain(JSON.stringify(sheet));
    const fonts = [...read(sheet).matchAll(/url\("?([^)"]+)"?\)/g)].map(
      ([, url]) => url as string,
    );
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(files).toContain(join("assets", font.replace(/^\.\//, "")));
    }
  });

  test("the service worker's manifest lists every file of this version but itself", () => {
    expect([...manifest.files].sort()).toEqual(
      files.filter((file) => file !== "sw.js"),
    );
    expect(read("sw.js")).toContain(JSON.stringify(manifest.version));
    expect(manifest.entry).toMatch(/^assets\/main-[A-Z0-9]{8}\.js$/);
  });

  test("it precaches what opening a document needs, and only that (SW4)", () => {
    expect(manifest.precache).toContain("index.html");
    expect(manifest.precache).toContain(manifest.entry);
    expect(manifest.precache.some((file) => /loro_wasm_bg-/.test(file))).toBe(
      true,
    );
    expect(
      manifest.precache.some((file) => /katex|pele|KaTeX/.test(file)),
    ).toBe(false);
    for (const file of manifest.precache) expect(files).toContain(file);
  });

  test("each compressible file has its brotli and gzip variants, which decompress to it (ADR-0049)", () => {
    const compressible = files.filter((file) => COMPRESSIBLE.test(file));
    expect(compressible).toContain("index.html");
    expect(compressible).toContain("sw.js");
    expect(compressible.some((file) => file.endsWith(".wasm"))).toBe(true);
    for (const file of compressible) {
      const bytes = readFileSync(join(outdir, file));
      for (const [suffix, decompress] of [
        [".br", brotliDecompressSync],
        [".gz", gunzipSync],
      ] as const) {
        const variant = `${file}${suffix}`;
        // Only where it is smaller: a tiny file may have none.
        if (!all.includes(variant)) {
          expect(bytes.length, variant).toBeLessThan(200);
          continue;
        }
        const packed = readFileSync(join(outdir, variant));
        expect(packed.length, variant).toBeLessThan(bytes.length);
        expect(decompress(packed).equals(bytes), variant).toBe(true);
      }
    }
    const wasm = compressible.find((file) => file.endsWith(".wasm"));
    expect(all).toContain(`${wasm}.br`);
  });

  test("a compressed format has no variant, and nothing else is one", () => {
    const variants = all.filter((file) => VARIANT.test(file));
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      expect(files, variant).toContain(variant.replace(VARIANT, ""));
      expect(variant).toMatch(/\.(html|js|css|wasm|ttf)\.(br|gz)$/);
    }
  });

  test("the service worker's manifest names no variant", () => {
    expect(manifest.files.filter((file) => VARIANT.test(file))).toEqual([]);
    expect(read("sw.js")).not.toMatch(/\.(js|wasm|html)\.(br|gz)"/);
  });

  // A size budget (AGENTS.md §6, docs/taille-du-bundle.md): the
  // JavaScript opening a document loads, as served in gzip (the larger of
  // the two variants), minified. Raised on purpose only, in the commit
  // that needs it, with its reason. Loro's WebAssembly is outside it.
  test("the JavaScript opening a document loads stays within its budget, in gzip", () => {
    const scripts = manifest.precache.filter((file) => file.endsWith(".js"));
    expect(scripts).toContain(manifest.entry);
    const gzipped = scripts.reduce(
      (sum, file) => sum + readFileSync(join(outdir, `${file}.gz`)).length,
      0,
    );
    expect(gzipped).toBeLessThanOrEqual(INITIAL_JS_GZIP_BUDGET);
  });

  test("its version changes with any file, the page included", async () => {
    // @ts-expect-error: plain JavaScript, without types.
    const { manifestOf } = await import("../../build-page.mjs");
    const contents = (file: string) =>
      file === "index.html" ? "<p>2</p>" : "same";
    const before = manifestOf(
      ["index.html", "assets/a-AAAA1111.js"],
      ["index.html"],
      "assets/a-AAAA1111.js",
      () => "same",
    );
    const after = manifestOf(
      ["index.html", "assets/a-AAAA1111.js"],
      ["index.html"],
      "assets/a-AAAA1111.js",
      contents,
    );
    expect(after.version).not.toBe(before.version);
  });
});
