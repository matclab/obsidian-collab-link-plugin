// @vitest-environment jsdom
import { flushSync } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import { LANGUAGE_KEY, setLanguage } from "../../i18n/index.js";
import { createLanguageField } from "./language-field.js";

afterEach(() => setLanguage("en"));

describe("the language, in the document menu (phase 10, decision 3)", () => {
  test("shows the page's language, keeps the one chosen, and reloads", () => {
    const container = document.createElement("div");
    const stored = new Map<string, string>();
    let reloads = 0;
    createLanguageField(container, {
      storage: {
        setItem: (key: string, value: string) => stored.set(key, value),
      },
      reload: () => reloads++,
    });
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === label,
      );
    expect(button("English")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Français")?.getAttribute("aria-pressed")).toBe("false");

    button("English")?.click();
    flushSync();
    expect(reloads).toBe(0);

    button("Français")?.click();
    flushSync();
    expect(stored.get(LANGUAGE_KEY)).toBe("fr");
    expect(reloads).toBe(1);
  });
});
