// The plugin's manifest (docs/phase-14-plugin-obsidian.md, decisions 5, 8,
// 13; ADR-0036 point 5).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "..", file), "utf8"));
const manifest = read("manifest.json");

describe("the manifest", () => {
  test("names the plugin without Obsidian's name, as the catalogue asks", () => {
    expect(manifest.id).toBe("collab-link");
    expect(manifest.id).not.toMatch(/obsidian/i);
    expect(manifest.name).not.toMatch(/obsidian/i);
    expect(manifest.description).not.toMatch(/obsidian/i);
  });

  test("asks for the version with app.secretStorage, on a computer only", () => {
    expect(manifest.minAppVersion).toBe("1.11.4");
    expect(manifest.isDesktopOnly).toBe(true);
  });

  test("has the package's version", () => {
    expect(manifest.version).toBe(read("package.json").version);
  });
});
