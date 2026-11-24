// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { askName } from "./name-dialog.js";

afterEach(() => document.body.replaceChildren());

const dialog = () => document.querySelector<HTMLDialogElement>(".name-dialog");

describe("the first name, asked in a dialog (phase 10b)", () => {
  test("says what it is for and that it is not verified; resolves with what is typed", async () => {
    const asked = askName(document.body);
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.textContent).toContain("not verified");
    const input = dialog()?.querySelector("input");
    if (input) input.value = "Alice";
    dialog()?.querySelector<HTMLButtonElement>(".name-continue")?.click();
    expect(await asked).toBe("Alice");
    expect(dialog()).toBeNull();
  });

  test("closed without an answer, it resolves with none", async () => {
    const asked = askName(document.body);
    dialog()?.querySelector<HTMLButtonElement>(".dialog-close")?.click();
    expect(await asked).toBeNull();
  });
});
