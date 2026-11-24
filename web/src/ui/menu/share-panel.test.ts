// @vitest-environment jsdom
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import { createSharePanel } from "./share-panel.js";

const LINKS = {
  read: "https://h/?doc=d#k=K&r=read.R",
  suggest: "https://h/?doc=d#k=K&r=suggest.S",
  edit: "https://h/?doc=d#k=K&r=edit.E",
};

function setUp(role: "read" | "suggest" | "edit", confirmed = true) {
  const container = document.createElement("div");
  const copied: string[] = [];
  let renewals = 0;
  const panel = createSharePanel(container, {
    role,
    links: role === "edit" ? LINKS : undefined,
    onRenew: async () => {
      renewals++;
    },
    confirm: () => confirmed,
    copy: async (text) => {
      copied.push(text);
    },
  });
  const click = (selector: string) => {
    (container.querySelector(selector) as HTMLElement).click();
    flushSync();
  };
  return { container, panel, copied, click, renewals: () => renewals };
}

const fields = (container: Element) =>
  Array.from(container.querySelectorAll("input"), (input) => input.value);

describe("share panel", () => {
  test("a reader or a reviewer sees their role, and no link", () => {
    for (const role of ["read", "suggest"] as const) {
      const { container } = setUp(role);
      expect(container.textContent).toContain(
        role === "read" ? "Read only" : "Comment and suggest",
      );
      expect(container.querySelector(".share-button")).toBeNull();
      expect(fields(container)).toEqual([]);
    }
  });

  test("an editor sees the three links, what each role may do, and copies one", async () => {
    const { container, copied, click } = setUp("edit");
    expect(fields(container)).toEqual([LINKS.read, LINKS.suggest, LINKS.edit]);
    expect(container.textContent).toContain("Comment and suggest changes.");
    expect(container.textContent).toContain("carries the document's key");

    click(".copy-suggest");
    await Promise.resolve();
    flushSync();
    expect(copied).toEqual([LINKS.suggest]);
    expect(container.querySelector(".copy-suggest")?.textContent).toBe(
      "Copied",
    );
  });

  test("renewing asks first, then shows the new links", async () => {
    const declined = setUp("edit", false);
    declined.click(".renew-button");
    expect(declined.renewals()).toBe(0);

    const { container, panel, click, renewals } = setUp("edit");
    expect(container.querySelector(".renew")?.textContent).toContain(
      "stop working",
    );
    click(".renew-button");
    expect(renewals()).toBe(1);
    const renewed = { ...LINKS, read: "https://h/?doc=d#k=K&r=read.NEW" };
    panel.setLinks(renewed, true);
    expect(fields(container)[0]).toBe(renewed.read);
    expect(container.textContent).toContain("renewed");
  });
});
