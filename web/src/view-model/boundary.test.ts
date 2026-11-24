// The views' boundary (phase 38f): the editor and the shared models
// (`view-model/`) import nothing of the views (`ui/`) — what both read
// lives here, never in a view. Read from the sources, tests included.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = resolve(import.meta.dirname, "..");
const UI = join(SRC, "ui");

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

/** What `dir`'s files import from `ui/`. */
const intoViews = (dir: string) =>
  files(join(SRC, dir)).flatMap((path) =>
    specifiers(path)
      .filter(
        (spec) =>
          spec.startsWith(".") &&
          `${resolve(path, "..", spec)}/`.startsWith(`${UI}/`),
      )
      .map((spec) => `${relative(SRC, path)}: ${spec}`),
  );

describe("the views' boundary", () => {
  test("the editor imports nothing of the views", () => {
    expect(intoViews("editor")).toEqual([]);
  });

  test("the shared models import nothing of the views", () => {
    expect(intoViews("view-model")).toEqual([]);
  });
});
