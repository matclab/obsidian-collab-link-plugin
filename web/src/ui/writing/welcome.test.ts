// @vitest-environment jsdom
// The first visit's banner (phase 37g, ADR-0064, AC1 – AC3).
import { afterEach, describe, expect, test, vi } from "vitest";
import { HINTS_KEY, rememberHint, seenHints } from "./hints.js";
import { createWelcome } from "./welcome.js";

afterEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

function mounted(role: "edit" | "suggest" | "read", storage?: Storage) {
  const root = document.createElement("div");
  document.body.append(root);
  const onHelp = vi.fn();
  const welcome = createWelcome(root, {
    role,
    storage: storage ?? localStorage,
    onHelp,
  });
  const banner = () => root.querySelector<HTMLElement>(".welcome");
  const button = (label: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (element) => element.textContent?.trim() === label,
    );
  return { root, welcome, banner, button, onHelp };
}

describe("the first visit's banner", () => {
  test("for a writer: Markdown, the markup on the caret's line, the / menu", () => {
    const { banner, button } = mounted("edit");
    expect(banner()?.textContent).toContain("written in Markdown");
    expect(banner()?.textContent).toContain("Type /");
    expect(button("See the help")).toBeDefined();
    expect(button("Got it")).toBeDefined();
  });

  test("« Got it » alone closes it, for good in this browser (AC2)", () => {
    const first = mounted("edit");
    first.button("Got it")?.click();
    expect(first.banner()).toBeNull();
    expect(seenHints(localStorage).has("welcome-edit")).toBe(true);

    const again = mounted("edit");
    expect(again.banner()).toBeNull();
  });

  test("« See the help » opens it and leaves the banner", () => {
    const { banner, button, onHelp } = mounted("edit");
    button("See the help")?.click();
    expect(onHelp).toHaveBeenCalledTimes(1);
    expect(banner()).not.toBeNull();
    expect(seenHints(localStorage).size).toBe(0);
  });

  test("for a suggester: select to comment or suggest; its own, once", () => {
    rememberHint(localStorage, "welcome-edit");
    const { banner, button } = mounted("suggest");
    expect(banner()?.textContent).toContain("select a passage");
    expect(button("See the help")).toBeUndefined();
    button("Got it")?.click();
    expect(seenHints(localStorage)).toEqual(
      new Set(["welcome-edit", "welcome-suggest"]),
    );
  });

  test("none for a reader", () => {
    expect(mounted("read").banner()).toBeNull();
  });

  test("storage refused: shown, and closed by « Got it » all the same", () => {
    const refusing = {
      getItem: () => {
        throw new Error("refused");
      },
      setItem: () => {
        throw new Error("refused");
      },
    } as unknown as Storage;
    const { banner, button } = mounted("edit", refusing);
    expect(banner()).not.toBeNull();
    button("Got it")?.click();
    expect(banner()).toBeNull();
  });

  test("what is kept: a list of names, anything else read as nothing", () => {
    localStorage.setItem(HINTS_KEY, "{not json");
    expect(seenHints(localStorage).size).toBe(0);
    localStorage.setItem(HINTS_KEY, JSON.stringify(["markup", 3, null]));
    expect(seenHints(localStorage)).toEqual(new Set(["markup"]));
  });
});
