// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { createNotices } from "./notices.js";

describe("notices (phase 10b): under the header, never over the text", () => {
  test("each says its text, once, and can be dismissed", () => {
    const container = document.createElement("div");
    const notices = createNotices(container);
    notices.show("Access denied.");
    notices.show("Access denied.");
    notices.show("Saving failed.");
    const shown = () =>
      Array.from(
        container.querySelectorAll(".notice-text"),
        (n) => n.textContent,
      );
    expect(shown()).toEqual(["Saving failed.", "Access denied."]);
    expect(container.querySelector(".notice")?.getAttribute("role")).toBe(
      "alert",
    );

    container.querySelector<HTMLButtonElement>(".notice-dismiss")?.click();
    expect(shown()).toEqual(["Access denied."]);
  });

  test("one with something to do offers it", () => {
    const container = document.createElement("div");
    let reloads = 0;
    createNotices(container).show("The server was updated.", {
      label: "Reload",
      run: () => reloads++,
    });
    const action = container.querySelector<HTMLButtonElement>(".notice-action");
    expect(action?.textContent).toBe("Reload");
    action?.click();
    expect(reloads).toBe(1);
  });

  test("one with something to do: said again, the newest action; done, gone", () => {
    const container = document.createElement("div");
    const runs: string[] = [];
    const notices = createNotices(container);
    notices.show("Pasted.", { label: "Undo", run: () => runs.push("first") });
    notices.show("Pasted.", { label: "Undo", run: () => runs.push("second") });
    expect(container.querySelectorAll(".notice")).toHaveLength(1);

    container.querySelector<HTMLButtonElement>(".notice-action")?.click();

    expect(runs).toEqual(["second"]);
    expect(container.querySelector(".notice")).toBeNull();
  });
});
