#!/usr/bin/env node
// The changelogs (AGENTS.md §1.3), in Keep a Changelog's form
// (https://keepachangelog.com/en/1.1.0/): CHANGELOG.md, the project's, and
// obsidian/CHANGELOG.md, the plugin's, which its GitHub repository takes
// (scripts/plugin-mirror.mjs). A change is written under [Unreleased] in
// its own commit; a release dates that section.
//
//   node scripts/changelog.mjs release x.y.z [yyyy-mm-dd]
//       both changelogs' [Unreleased] under x.y.z and the date (today's by
//       default), the compare links updated; the project's refused if
//       nothing is there; a version already dated left as it is
//   node scripts/changelog.mjs notes <file> x.y.z
//       that version's section, without its heading (a release's notes)
//   node scripts/changelog.mjs check
//       both have [Unreleased] and the VERSION file's section
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A section's end: the next heading, or the links below them all.
const SECTION_END = /^## |^\[[^\]]+\]: /m;
const PLUGIN_UNCHANGED =
  "No change in the plugin itself: released with the project.";

const heading = (version) =>
  new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]( - .*)?$`, "m");

/** `text` with its [Unreleased] section dated as `version`; with nothing
 * there, refused, or `empty` written in its place. */
export function release(text, version, date, { empty } = {}) {
  if (heading(version).test(text)) return text;
  const unreleased = /^## \[Unreleased\]\n/m.exec(text);
  if (!unreleased) throw new Error("no [Unreleased] section");
  const start = unreleased.index + unreleased[0].length;
  const rest = text.slice(start);
  const end = SECTION_END.exec(rest)?.index ?? rest.length;
  const after = rest.slice(end);
  let body = rest.slice(0, end);
  if (body.trim() === "") {
    if (empty === undefined) throw new Error("nothing under [Unreleased]");
    body = `\n${empty}\n${after ? "\n" : ""}`;
  }
  return `${text.slice(0, start)}\n## [${version}] - ${date}\n${body}${after}`.replace(
    /^\[Unreleased\]: (.*)\/compare\/v(.+)\.\.\.HEAD$/m,
    (_, base, previous) =>
      `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${previous}...v${version}`,
  );
}

/** `version`'s section in `text`, without its heading. */
export function notes(text, version) {
  const found = heading(version).exec(text);
  if (!found) throw new Error(`no section for ${version}`);
  const rest = text.slice(found.index + found[0].length);
  const end = SECTION_END.exec(rest)?.index ?? rest.length;
  return `${rest.slice(0, end).trim()}\n`;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  { file: "CHANGELOG.md" },
  { file: "obsidian/CHANGELOG.md", empty: PLUGIN_UNCHANGED },
];

function main([command, ...args]) {
  const read = (file) => readFileSync(join(ROOT, file), "utf8");
  if (command === "release" && args[0]) {
    const [version, date = new Date().toISOString().slice(0, 10)] = args;
    // Both checked before either is written.
    const written = FILES.map(({ file, empty }) => {
      try {
        return [file, release(read(file), version, date, { empty })];
      } catch (error) {
        throw new Error(`${file}: ${error.message}`);
      }
    });
    const changed = written.filter(([file, text]) => text !== read(file));
    for (const [file, text] of changed) writeFileSync(join(ROOT, file), text);
    console.log(
      changed.length === 0
        ? `${version}: already dated in both changelogs`
        : `${version}: dated ${date} in both changelogs`,
    );
  } else if (command === "notes" && args.length === 2) {
    process.stdout.write(notes(readFileSync(args[0], "utf8"), args[1]));
  } else if (command === "check") {
    const version = read("VERSION").trim();
    for (const { file } of FILES) {
      const text = read(file);
      if (!/^## \[Unreleased\]$/m.test(text)) {
        throw new Error(`${file}: no [Unreleased] section`);
      }
      if (!heading(version).test(text)) {
        throw new Error(`${file}: no section for ${version}`);
      }
    }
    console.log(`${version}: in both changelogs`);
  } else {
    console.error(
      "usage: changelog.mjs release x.y.z [yyyy-mm-dd] | notes <file> x.y.z | check",
    );
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
