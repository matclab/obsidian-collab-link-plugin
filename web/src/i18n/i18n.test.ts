// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { en } from "./en.js";
import { fr } from "./fr.js";
import {
  chooseLanguage,
  currentLanguage,
  formatDate,
  setLanguage,
  t,
} from "./index.js";

afterEach(() => setLanguage("en"));

describe("the page's language (phase 10, decision 3)", () => {
  test("the one chosen in this browser comes first", () => {
    expect(chooseLanguage("fr", ["en-US"])).toBe("fr");
    expect(chooseLanguage("en", ["fr-FR"])).toBe("en");
  });

  test("else the first of the browser's preferences the page speaks", () => {
    expect(chooseLanguage(null, ["fr-CA", "en"])).toBe("fr");
    expect(chooseLanguage(null, ["de-DE", "en-GB", "fr"])).toBe("en");
    expect(chooseLanguage("klingon", ["FR"])).toBe("fr");
  });

  test("else English", () => {
    expect(chooseLanguage(null, ["de", "it"])).toBe("en");
    expect(chooseLanguage(undefined, [])).toBe("en");
  });

  test("setting it changes the texts, the page's lang, and the dates", () => {
    setLanguage("fr", document.documentElement);
    expect(currentLanguage()).toBe("fr");
    expect(t().share).toBe("Partager");
    expect(document.documentElement.lang).toBe("fr");
    const at = Date.UTC(2026, 9, 4, 12, 0);
    expect(formatDate(at)).toBe(new Date(at).toLocaleString("fr"));
    setLanguage("en");
    expect(t().share).toBe("Share");
    expect(formatDate(at)).toBe(new Date(at).toLocaleString("en"));
  });

  test("without an element, no lang is written: another host's (Obsidian's) stays", () => {
    document.documentElement.lang = "de";
    setLanguage("fr");
    expect(t().share).toBe("Partager");
    expect(document.documentElement.lang).toBe("de");
  });
});

describe("counts take each language's plural", () => {
  test("in French, 0 and 1 are singular", () => {
    expect(fr.invalidEntries(0)).toBe("0 entrée illisible ignorée");
    expect(fr.invalidEntries(1)).toBe("1 entrée illisible ignorée");
    expect(fr.invalidEntries(2)).toBe("2 entrées illisibles ignorées");
  });

  test("in English, only 1 is", () => {
    expect(en.invalidEntries(0)).toBe("0 unreadable entries ignored");
    expect(en.invalidEntries(1)).toBe("1 unreadable entry ignored");
  });
});

test("every French text is written, not left in English", () => {
  // The same word in both languages, on purpose.
  const same = new Set([
    "document",
    "annotations",
    "source",
    "versionsTitle",
    "constructCode",
    "constructImage",
    "journalDate",
    "journalNote",
    // Callout families named alike in both (ADR-0063).
    "calloutNote",
    "calloutInfo",
    "calloutQuestion",
    "calloutDanger",
    // Key names, written so on French keyboards too.
    "keyCtrl",
    "keyAlt",
    "keyTab",
    // Examples whose text is no word (phase 20d).
    "exampleMathBlock",
    "exampleDiagram",
    "exampleRule",
    // The product's name, on a notification that says nothing else.
    "pushGenericTitle",
  ]);
  const untranslated = Object.entries(en).filter(
    ([key, value]) =>
      typeof value === "string" &&
      !same.has(key) &&
      value === fr[key as keyof typeof fr],
  );
  expect(untranslated).toEqual([]);
});

// The texts with parameters, in both languages: each writes every value
// it is given, and a count of 1 or 3 never breaks it (the page's tests,
// in English, never call the French ones).
describe("every text with parameters", () => {
  for (const [language, dictionary] of [
    ["en", en],
    ["fr", fr],
  ] as const) {
    test(`writes each of its values, in ${language}`, () => {
      setLanguage(language);
      const missing: string[] = [];
      for (const [key, value] of Object.entries(dictionary)) {
        if (typeof value !== "function") continue;
        const text = value as (...args: unknown[]) => string;
        const marks = Array.from({ length: text.length }, (_, i) => `⟨${i}⟩`);
        const written = text(...marks);
        for (const mark of marks) {
          if (!written.includes(mark)) missing.push(`${key} ${mark}`);
        }
        for (const count of [1, 3]) {
          const counted = text(...marks.map(() => count));
          expect(counted, key).toMatch(/\p{L}|\d/u);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});

// Two keys the reader is told of, never one name for both (2026-11-08):
// the key of « Mes documents », never given, and the signing key, whose
// fingerprint is given to who checks.
describe("the two keys are named apart", () => {
  test("in French", () => {
    expect(fr.showKey).toBe("Afficher la clé de Mes documents");
    expect(fr.signedWith("e009 ccbd")).toBe(
      "Signé avec la clé de signature e009 ccbd",
    );
  });

  test("in English", () => {
    expect(en.showKey).toBe("Show the My documents key");
    expect(en.signedWith("e009 ccbd")).toBe(
      "Signed with signing key e009 ccbd",
    );
  });
});
