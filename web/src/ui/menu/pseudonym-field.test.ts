// @vitest-environment jsdom
// The pseudonym, changed from the page (phase 7 decision 9, ADR-0008):
// said to be a display name, not verified.
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import { createPseudonymField } from "./pseudonym-field.js";

function setUp() {
  const container = document.createElement("div");
  const renamed: string[] = [];
  const field = createPseudonymField(container, {
    name: "alice",
    save: (name) => {
      const trimmed = name.trim();
      return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
    },
    onRenamed: (name) => renamed.push(name),
  });
  const find = (selector: string) =>
    container.querySelector(selector) as HTMLInputElement | null;
  const click = (selector: string) => {
    find(selector)?.click();
    flushSync();
  };
  return { container, renamed, find, click, field };
}

describe("pseudonym field", () => {
  test("shows the name in a field, said not to be verified", () => {
    const { container, find } = setUp();
    expect(find(".pseudonym-input")?.value).toBe("alice");
    expect(container.textContent).toContain("not verified");
  });

  test("saves a new one: it is reported, the field keeps it", () => {
    const { renamed, find, click } = setUp();
    const input = find(".pseudonym-input");
    if (input) input.value = "  Alice B. ";
    click(".pseudonym-save");

    expect(renamed).toEqual(["Alice B."]);
    expect(find(".pseudonym-input")?.value).toBe("Alice B.");
    expect(find(".pseudonym-error")).toBeNull();
  });

  test("a name refused is said, nothing reported", () => {
    const { container, renamed, find, click } = setUp();
    const input = find(".pseudonym-input");
    if (input) input.value = "   ";
    click(".pseudonym-save");
    expect(renamed).toEqual([]);
    expect(container.textContent).toContain("1 to 200 characters");
  });

  test("signed in: the identity's name, not to change; signed out: the pseudonym again", () => {
    const { container, find, field } = setUp();
    field.show("Ada Lovelace", true);
    flushSync();
    expect(find(".pseudonym-input")?.value).toBe("Ada Lovelace");
    expect(find(".pseudonym-input")?.disabled).toBe(true);
    expect(find(".pseudonym-save")).toBeNull();
    expect(container.textContent).toContain("Your identity's name");

    field.show("alice", false);
    flushSync();
    expect(find(".pseudonym-input")?.value).toBe("alice");
    expect(find(".pseudonym-input")?.disabled).toBe(false);
    expect(container.textContent).toContain("not verified");
  });
});
