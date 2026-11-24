// The plugin's GitHub repository (obsidian/README.md, "Publish"): what
// Obsidian's community directory reads, written from a tagged release of
// this one by `scripts/plugin-mirror.mjs` — the plugin and the page it
// bundles, its manifest, README and licence at the root, the workflow that
// builds the release, one commit and its tag x.y.z.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error: a script, without types
import { rootReadme, versionsJson } from "../../scripts/plugin-mirror.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = "https://gitlab.com/matclab/obsidian-collab-link";
const CHANGELOG =
  "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n- [Fixed](../docs/x.md).\n";

describe("the README at the mirror's root", () => {
  test("points what it cites outside obsidian/ to the source, at the tag", () => {
    expect(
      rootReadme(
        "A [server](../README.md) and [its rules](../docs/a.md#b).\n",
        "1.2.3",
      ),
    ).toBe(
      `A [server](${SOURCE}/-/blob/v1.2.3/README.md) and [its rules](${SOURCE}/-/blob/v1.2.3/docs/a.md#b).\n`,
    );
  });

  test("leaves other links, and code, as they are", () => {
    const text =
      "[web](https://x.org/a) [here](#use) `![…](Collab%20Link/images/x.png)`\n";
    expect(rootReadme(text, "1.2.3")).toBe(text);
  });
});

describe("versions.json", () => {
  test("adds the version and its minimum Obsidian to those before", () => {
    expect(versionsJson('{"0.1.0": "1.0.0"}', "0.2.0", "1.1.0")).toBe(
      '{\n  "0.1.0": "1.0.0",\n  "0.2.0": "1.1.0"\n}\n',
    );
    expect(versionsJson(undefined, "0.2.0", "1.1.0")).toBe(
      '{\n  "0.2.0": "1.1.0"\n}\n',
    );
  });
});

// The whole script, from a throwaway source repository into a throwaway
// clone of the mirror.
describe("writing the mirror", () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.org",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.org",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  const write = (dir: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  };
  const manifest = (version: string) =>
    `${JSON.stringify({ id: "collab-link", version, minAppVersion: "1.11.4" })}\n`;

  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-mirror-"));
    const source = join(dir, "source");
    const mirror = join(dir, "mirror");
    for (const repo of [source, mirror]) {
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
    }
    write(source, {
      VERSION: "1.2.3\n",
      LICENSE: "Apache License\n",
      "obsidian/manifest.json": manifest("1.2.3"),
      "obsidian/README.md":
        "# Collab Link\n\nSee [the server](../README.md).\n",
      "obsidian/src/main.ts": "export {};\n",
      "web/src/page.ts": "export {};\n",
      "obsidian/CHANGELOG.md": CHANGELOG,
      "server/Cargo.toml": "[workspace]\n",
    });
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "Release 1.2.3");
    git(source, "tag", "v1.2.3");
    write(mirror, {
      "versions.json": '{"1.2.2": "1.11.0"}\n',
      "old.txt": "gone\n",
    });
    git(mirror, "add", "-A");
    git(mirror, "commit", "-q", "-m", "Collab Link 1.2.2");
    const run = (...args: string[]) =>
      spawnSync(
        "node",
        [join(ROOT, "scripts/plugin-mirror.mjs"), "--source", source, ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "test",
            GIT_AUTHOR_EMAIL: "test@example.org",
            GIT_COMMITTER_NAME: "test",
            GIT_COMMITTER_EMAIL: "test@example.org",
          },
        },
      );
    return { dir, source, mirror, run };
  };

  test("writes the release's plugin and page, the root's files, a commit and its tag", () => {
    const { dir, mirror, run } = setUp();
    try {
      const result = run(mirror, "v1.2.3");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const at = (file: string) => readFileSync(join(mirror, file), "utf8");
      expect(at("manifest.json")).toBe(manifest("1.2.3"));
      expect(at("LICENSE")).toBe("Apache License\n");
      expect(at("README.md")).toBe(
        `# Collab Link\n\nSee [the server](${SOURCE}/-/blob/v1.2.3/README.md).\n`,
      );
      expect(at("obsidian/src/main.ts")).toBe("export {};\n");
      expect(at("web/src/page.ts")).toBe("export {};\n");
      // The plugin's changelog, the release's notes taken from it.
      expect(at("CHANGELOG.md")).toBe(
        `# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n- [Fixed](${SOURCE}/-/blob/v1.2.3/docs/x.md).\n`,
      );
      expect(at(".github/changelog.mjs")).toBe(
        readFileSync(join(ROOT, "scripts/changelog.mjs"), "utf8"),
      );
      expect(at(".github/workflows/release.yml")).toContain(
        "node .github/changelog.mjs notes CHANGELOG.md",
      );
      expect(JSON.parse(at("versions.json"))).toEqual({
        "1.2.2": "1.11.0",
        "1.2.3": "1.11.4",
      });
      const pkg = JSON.parse(at("package.json"));
      expect(pkg.version).toBe("1.2.3");
      expect(pkg.license).toBe("Apache-2.0");
      expect(pkg.scripts.build).toContain("npm ci");
      expect(at(".github/workflows/release.yml")).toContain(
        "gh release create",
      );
      // Only what the plugin needs; nothing left from before.
      expect(existsSync(join(mirror, "server"))).toBe(false);
      expect(existsSync(join(mirror, "old.txt"))).toBe(false);
      expect(git(mirror, "status", "--porcelain")).toBe("");
      expect(git(mirror, "tag", "--points-at", "HEAD").trim()).toBe("1.2.3");
      expect(git(mirror, "log", "-1", "--format=%s").trim()).toBe(
        "Collab Link 1.2.3",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a mirror with changes, or with the tag already, or a release without its changelog section, and changes nothing", () => {
    const { dir, source, mirror, run } = setUp();
    try {
      write(source, {
        "obsidian/CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- Soon.\n",
      });
      git(source, "commit", "-q", "-am", "Release 1.2.4");
      git(source, "tag", "v1.2.4");
      expect(run(mirror, "v1.2.4").stderr).toMatch(/no section for 1\.2\.3/);
      writeFileSync(join(mirror, "draft.txt"), "draft\n");
      expect(run(mirror, "v1.2.3").status).not.toBe(0);
      rmSync(join(mirror, "draft.txt"));
      git(mirror, "tag", "1.2.3");
      expect(run(mirror, "v1.2.3").status).not.toBe(0);
      expect(existsSync(join(mirror, "old.txt"))).toBe(true);
      expect(git(mirror, "log", "-1", "--format=%s").trim()).toBe(
        "Collab Link 1.2.2",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
