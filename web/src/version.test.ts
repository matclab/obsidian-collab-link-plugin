// The software's version (README, "Versions"): one source, the VERSION
// file at the root; every other place a version is written — the server's
// crates, the packages, the plugin's manifest, the page's own module, the
// lock files — says the same (`scripts/version.mjs check`).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("the version", () => {
  test("is written the same everywhere", () => {
    const output = execFileSync(
      "node",
      [join(ROOT, "scripts/version.mjs"), "check"],
      { encoding: "utf8" },
    );
    expect(output.trim()).toBe(
      `${readFileSync(join(ROOT, "VERSION"), "utf8").trim()}: everywhere`,
    );
  });

  test("the page's is the VERSION file's", () => {
    expect(VERSION).toBe(readFileSync(join(ROOT, "VERSION"), "utf8").trim());
  });
});

// `set`, on a copy of the files it writes: every place then says the new
// version; a version not greater, or not x.y.z, changes nothing.
describe("setting the version", () => {
  const FILES = [
    "VERSION",
    "scripts/version.mjs",
    "server/Cargo.toml",
    "server/Cargo.lock",
    "server/fuzz/Cargo.lock",
    "web/package.json",
    "web/lib/package.json",
    "web/package-lock.json",
    "web/src/version.ts",
    "obsidian/package.json",
    "obsidian/manifest.json",
  ];
  const copy = () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-version-"));
    for (const file of FILES) {
      cpSync(join(ROOT, file), join(dir, file), { recursive: true });
    }
    const run = (...args: string[]) =>
      spawnSync("node", [join(dir, "scripts/version.mjs"), ...args], {
        encoding: "utf8",
      });
    return { dir, run };
  };

  test("writes it everywhere", () => {
    const { dir, run } = copy();
    try {
      const now = readFileSync(join(dir, "VERSION"), "utf8").trim();
      const [major, minor] = now.split(".").map(Number);
      const next = `${major}.${(minor ?? 0) + 1}.0`;
      expect(run("set", next).status).toBe(0);
      const checked = run("check");
      expect(checked.stdout.trim()).toBe(`${next}: everywhere`);
      expect(
        JSON.parse(readFileSync(join(dir, "obsidian/manifest.json"), "utf8"))
          .version,
      ).toBe(next);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a version not greater, or not x.y.z, and changes nothing", () => {
    const { dir, run } = copy();
    try {
      const now = readFileSync(join(dir, "VERSION"), "utf8").trim();
      for (const wrong of [now, "0.0.1", "1.2", "v1.2.3", "1.2.3-rc"]) {
        expect(run("set", wrong).status, wrong).not.toBe(0);
      }
      expect(readFileSync(join(dir, "VERSION"), "utf8").trim()).toBe(now);
      expect(run("check").status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
