import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ambiguous, definitions, render, unqualified } from "./rules-index.js";

const root = path.resolve(import.meta.dirname, "../../..");

/** The code that cites rules: the server, the client, the page, scripts. */
function sources(): { file: string; text: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return ["node_modules", "target", "dist"].includes(entry.name)
          ? []
          : walk(full);
      }
      return /\.(rs|ts|svelte|mjs)$/.test(entry.name) ? [full] : [];
    });
  return (
    [
      ...walk(path.join(root, "server")),
      ...walk(path.join(root, "web/src")),
      ...walk(path.join(root, "web/lib/src")),
      ...walk(path.join(root, "web/scripts")),
    ]
      // The index's own code cites identifiers as examples.
      .filter(
        (file) => !file.includes(`${path.sep}src${path.sep}docs${path.sep}`),
      )
      .map((file) => ({
        file: path.relative(root, file),
        text: readFileSync(file, "utf8"),
      }))
  );
}

describe("the index of rule identifiers (docs/rules-index.md)", () => {
  test("is up to date: node scripts/rules-index.mjs writes it", () => {
    const written = readFileSync(
      path.join(root, "docs/rules-index.md"),
      "utf8",
    );
    expect(written).toBe(render(definitions(root)));
  });

  test("the code cites no identifier two documents define without naming one of them", () => {
    const amb = ambiguous(definitions(root));
    const found = unqualified(sources(), amb).map(
      ({ file, line, id, text }) => `${file}:${line} ${id}: ${text}`,
    );
    expect(found).toEqual([]);
  });

  test("a citation is qualified by its document on its line or the two before", () => {
    const amb = new Map([
      ["L4", ["docs/phase-7-x.md", "docs/phase-9-y.md"]],
      ["P5", ["docs/phase-7-x.md", "docs/security/threat-model.md"]],
    ]);
    const cited = (text: string) =>
      unqualified([{ file: "a.ts", text }], amb).map(({ id }) => id);
    expect(cited("// (phase 9, L4)")).toEqual([]);
    expect(cited("// docs/phase-9-y.md,\n// analysis L4")).toEqual([]);
    expect(cited("// P5 (threat model)")).toEqual([]);
    expect(cited("// R-L4 and R-P5 are other rules")).toEqual([]);
    expect(cited("// a panic (L4)")).toEqual(["L4"]);
    expect(cited("// phase 19 P5")).toEqual(["P5"]);
    expect(cited("// phase 7\n//\n//\n// P5")).toEqual(["P5"]);
  });
});
