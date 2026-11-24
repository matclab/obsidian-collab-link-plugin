import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

/** The words CONTEXT.md says no text of the interface contains, from its
 * `_Jamais affiché_` lines. */
function neverShown(): string[] {
  const context = readFileSync(path.join(root, "CONTEXT.md"), "utf8");
  return [...context.matchAll(/^_Jamais affiché_ : (.+)$/gm)].flatMap(
    ([, words = ""]) => words.split(", ").map((word) => word.trim()),
  );
}

/** Each key of the French dictionary with its source: the literals and the
 * template, plural branches included — calling a function would show one. */
function frenchTexts(): Map<string, string> {
  const source = readFileSync(path.join(import.meta.dirname, "fr.ts"), "utf8");
  const body = source.slice(source.indexOf("export const fr = {"));
  const texts = new Map<string, string>();
  for (const chunk of body.split(/\n {2}(?=[A-Za-z]\w*:)/).slice(1)) {
    const key = chunk.slice(0, chunk.indexOf(":"));
    texts.set(key, chunk.slice(key.length + 1).replace(/\/\/.*$/gm, ""));
  }
  return texts;
}

/** A word and its forms: `rejet` finds « rejeté », « rejeter ». */
function contains(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\d])${escaped}`, "iu").test(text);
}

/** Where a never-shown word is right, in another sense. */
const exceptions: Record<string, { word: string; why: string }> = {
  pluginNoKeyring: {
    word: "trousseau",
    why: "the operating system's keychain, not Mes documents",
  },
};

describe("the interface's vocabulary (CONTEXT.md)", () => {
  test("CONTEXT.md lists the words never shown", () => {
    expect(neverShown()).toContain("rotation");
    expect(neverShown()).toContain("note partagée");
  });

  test("the forms of a word are found, not a word that merely contains it", () => {
    expect(contains("a rejeté votre", "rejet")).toBe(true);
    expect(contains("Rejeter", "rejet")).toBe(true);
    expect(contains("un projet", "rejet")).toBe(false);
    expect(contains("une prérotation", "rotation")).toBe(false);
  });

  test("no French text contains a word never shown", () => {
    const words = neverShown();
    const found = [...frenchTexts()].flatMap(([key, text]) =>
      words
        .filter((word) => contains(text, word))
        .filter((word) => exceptions[key]?.word !== word)
        .map((word) => `${key}: ${word}`),
    );
    expect(found).toEqual([]);
  });

  test("each exception is still needed", () => {
    const texts = frenchTexts();
    for (const [key, { word }] of Object.entries(exceptions)) {
      expect(neverShown()).toContain(word);
      expect(contains(texts.get(key) ?? "", word)).toBe(true);
    }
  });
});
