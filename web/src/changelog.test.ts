// The changelogs (AGENTS.md §1.3): CHANGELOG.md for the project,
// obsidian/CHANGELOG.md for the plugin, in Keep a Changelog's form. A change
// goes under [Unreleased] in its commit; `make release` dates that section
// (`scripts/changelog.mjs release`); the plugin's GitHub release takes its
// version's section as notes (`notes`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error: a script, without types
import { notes, release } from "../../scripts/changelog.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = "https://example.org/repo/-/compare";

const changelog = (unreleased: string) =>
  `# Changelog\n\nIntro.\n\n## [Unreleased]\n${unreleased}\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First.\n\n[Unreleased]: ${BASE}/v1.0.0...HEAD\n[1.0.0]: ${BASE}/v0.9.0...v1.0.0\n`;

describe("dating a release", () => {
  test("moves what is unreleased under the version and its date, links updated", () => {
    expect(
      release(changelog("\n### Fixed\n\n- A bug.\n"), "1.1.0", "2026-02-03"),
    ).toBe(
      `# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [1.1.0] - 2026-02-03\n\n### Fixed\n\n- A bug.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- First.\n\n[Unreleased]: ${BASE}/v1.1.0...HEAD\n[1.1.0]: ${BASE}/v1.0.0...v1.1.0\n[1.0.0]: ${BASE}/v0.9.0...v1.0.0\n`,
    );
  });

  test("without links, adds none", () => {
    const text = "## [Unreleased]\n\n- A bug.\n";
    expect(release(text, "1.1.0", "2026-02-03")).toBe(
      "## [Unreleased]\n\n## [1.1.0] - 2026-02-03\n\n- A bug.\n",
    );
  });

  test("nothing unreleased: refused, or the text given in its place", () => {
    expect(() => release(changelog("\n"), "1.1.0", "2026-02-03")).toThrow(
      /nothing under \[Unreleased\]/,
    );
    expect(
      release(
        "## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n",
        "1.1.0",
        "2026-02-03",
        {
          empty: "Nothing new.",
        },
      ),
    ).toBe(
      "## [Unreleased]\n\n## [1.1.0] - 2026-02-03\n\nNothing new.\n\n## [1.0.0] - 2026-01-01\n",
    );
  });

  test("a version already dated is left as it is", () => {
    const text = changelog("\n");
    expect(release(text, "1.0.0", "2026-02-03")).toBe(text);
  });
});

describe("a release's notes", () => {
  test("are its section, without its heading", () => {
    expect(notes(changelog("\n- Next.\n"), "1.0.0")).toBe(
      "### Added\n\n- First.\n",
    );
  });

  test("end at the next heading, a version's or not", () => {
    expect(
      notes(
        "## [1.0.0] - 2026-01-01\n\n- First.\n\n## Earlier versions\n\nSee.\n",
        "1.0.0",
      ),
    ).toBe("- First.\n");
  });

  test("an unknown version has none", () => {
    expect(() => notes(changelog("\n"), "2.0.0")).toThrow(
      /no section for 2\.0\.0/,
    );
  });
});

describe("the repository's changelogs", () => {
  test("both have [Unreleased] and the current version's section", () => {
    const output = execFileSync(
      "node",
      [join(ROOT, "scripts/changelog.mjs"), "check"],
      {
        encoding: "utf8",
      },
    );
    expect(output.trim()).toBe(
      `${readFileSync(join(ROOT, "VERSION"), "utf8").trim()}: in both changelogs`,
    );
  });
});
