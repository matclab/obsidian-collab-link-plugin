// The library's boundary (docs/phase-8-protocole-ouvert.md, C3): its code
// depends on nothing but `loro-crdt` and itself — no editor, no interface
// framework —, its tests on nothing of the page; and the page's code
// reaches it only through its entry, `index.ts`. Read from the sources.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const WEB = resolve(import.meta.dirname, "../..");
const LIB = join(WEB, "lib/src");
const PAGE = join(WEB, "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module a file names: imports, re-exports, dynamic imports,
 * mocks. */
function specifiers(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found = text.matchAll(
    /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\bvi\.mock\(\s*)"([^"\n]+)"/g,
  );
  return [...found].map((match) => match[1] as string);
}

const isTest = (path: string) =>
  path.endsWith(".test.ts") || path.includes("/test-support/");

/** Test tools of the page, which may reach into the library like its own
 * tests do. */
const PAGE_HELPERS = [
  "integration/",
  "bench/",
  "e2e/",
  "perf/harness.ts",
  "perf/scenario.ts",
];
const isPageHelper = (path: string) =>
  isTest(path) ||
  PAGE_HELPERS.some((helper) => relative(PAGE, path).startsWith(helper));

describe("the library's boundary", () => {
  test("its code imports only loro-crdt and itself", () => {
    const outside = files(LIB)
      .filter((path) => !isTest(path))
      .flatMap((path) =>
        specifiers(path)
          .filter((spec) =>
            spec.startsWith(".")
              ? !resolve(path, "..", spec).startsWith(LIB)
              : spec !== "loro-crdt",
          )
          .map((spec) => `${relative(WEB, path)}: ${spec}`),
      );
    expect(outside).toEqual([]);
  });

  test("its tests import nothing of the page", () => {
    const page = files(LIB)
      .filter(isTest)
      .flatMap((path) =>
        specifiers(path)
          .filter(
            (spec) =>
              spec.startsWith(".") &&
              resolve(path, "..", spec).startsWith(PAGE),
          )
          .map((spec) => `${relative(WEB, path)}: ${spec}`),
      );
    expect(page).toEqual([]);
  });

  test("the page's code reaches it only through its entry", () => {
    const entry = join(LIB, "index.ts");
    const deep = files(PAGE)
      .filter((path) => !isPageHelper(path))
      .flatMap((path) =>
        specifiers(path)
          .filter((spec) => {
            if (!spec.startsWith(".")) return false;
            const target = resolve(path, "..", spec).replace(/\.js$/, ".ts");
            return target.startsWith(LIB) && target !== entry;
          })
          .map((spec) => `${relative(WEB, path)}: ${spec}`),
      );
    expect(deep).toEqual([]);
  });
});
