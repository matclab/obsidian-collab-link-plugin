// The name an export is saved under: the document's title, as a file can
// be named on any system, or « document ».
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { exportName } from "./export-name.js";

/** What a name must be, saved anywhere (Windows, macOS, Linux, a vault). */
function acceptable(name: string, suffix: string): string | undefined {
  if (!name.endsWith(suffix)) return "suffix";
  const base = name.slice(0, -suffix.length);
  if (base === "") return "empty";
  if (/[\\/:*?"<>|#^[\]\p{Cc}]/u.test(base)) return "a character refused";
  if (/^[ .]|[ .]$/.test(base)) return "a space or a dot at an end";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) return "reserved";
  if (new TextEncoder().encode(name).length > 255) return "too long";
  return undefined;
}

describe("exportName", () => {
  test("the title, its Markdown kept apart from what a file can't hold", () => {
    expect(exportName("# Compte rendu\n\ntexte", ".md")).toBe(
      "Compte rendu.md",
    );
    expect(exportName("# Réunion du 22/10 : décisions ?", ".md")).toBe(
      "Réunion du 22 10 décisions.md",
    );
    expect(exportName("## *Notes* [projet] #3", ".annotations.md")).toBe(
      "Notes projet 3.annotations.md",
    );
  });

  test("no title, or nothing left of it: « document »", () => {
    expect(exportName("du texte, sans titre", ".md")).toBe("document.md");
    expect(exportName("", ".annotations.md")).toBe("document.annotations.md");
    expect(exportName("# ???", ".md")).toBe("document.md");
    expect(exportName("# ...", ".md")).toBe("document.md");
  });

  test("no hidden file, no name Windows keeps for itself", () => {
    expect(exportName("# .config", ".md")).toBe("config.md");
    expect(exportName("# Fin.", ".md")).toBe("Fin.md");
    expect(exportName("# CON", ".md")).toBe("CON_.md");
    expect(exportName("# lpt1", ".md")).toBe("lpt1_.md");
  });

  test("an invisible character, which would make a name read as another, is not kept", () => {
    const override = String.fromCodePoint(0x202e);
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(exportName(`# Fac${override}txt.exe`, ".md")).toBe("Fac txt.exe.md");
    expect(exportName(`# A${zeroWidth}B`, ".md")).toBe("A B.md");
  });

  test("a long title is cut, never inside a character", () => {
    const name = exportName(`# ${"é".repeat(300)}`, ".annotations.md");
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name).toMatch(/^é+\.annotations\.md$/);
    const emoji = exportName(`# ${"😀".repeat(100)}`, ".md");
    expect(emoji).toMatch(/^(😀)+\.md$/u);
  });

  test("whatever the title, a name any system accepts (property)", () =>
    hegel.test(
      (tc) => {
        const title = tc.draw(gs.text({ maxSize: 300 }));
        const suffix = tc.draw(gs.sampledFrom([".md", ".annotations.md"]));
        const name = exportName(`# ${title}\n`, suffix);
        const wrong = acceptable(name, suffix);
        if (wrong) throw new Error(`${wrong}: ${JSON.stringify(name)}`);
      },
      { testCases: 400 },
    ));
});
