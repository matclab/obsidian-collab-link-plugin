// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import type { Role } from "../../../lib/src/index.js";
import { createHeader } from "./header.js";

function setUp(role: Role) {
  const container = document.createElement("div");
  const clicks: string[] = [];
  const header = createHeader(container, {
    role,
    onShare: () => clicks.push("share"),
    onDocument: () => clicks.push("document"),
    homeHref: "https://collab.test/",
    onIdentity: (kind) => clicks.push(kind),
  });
  const find = (selector: string) =>
    container.querySelector<HTMLElement>(selector);
  return { container, header, clicks, find };
}

describe("the header (phase 10b)", () => {
  test("shows the document's title, or says it has none", () => {
    const { header, find } = setUp("edit");
    expect(find(".doc-title")?.textContent).toBe("Untitled document");
    header.setTitle("Compte rendu");
    expect(find(".doc-title")?.textContent).toBe("Compte rendu");
    header.setTitle(undefined);
    expect(find(".doc-title")?.textContent).toBe("Untitled document");
  });

  test("never puts it in the tab's title, which the browser's history keeps (decision 5)", () => {
    const before = document.title;
    setUp("edit").header.setTitle("Secret plans");
    expect(document.title).toBe(before);
  });

  test("an editor shares; the others see their role instead", () => {
    const editor = setUp("edit");
    editor.find(".share-button")?.click();
    expect(editor.clicks).toEqual(["share"]);
    expect(editor.find(".role-badge")).toBeNull();

    for (const [role, label] of [
      ["suggest", "Comment and suggest"],
      ["read", "Read only"],
    ] as const) {
      const other = setUp(role);
      expect(other.find(".share-button")).toBeNull();
      expect(other.find(".role-badge")?.textContent).toBe(label);
    }
  });

  test("every role opens the document menu", () => {
    for (const role of ["edit", "suggest", "read"] as const) {
      const { find, clicks } = setUp(role);
      const button = find(".document-button");
      expect(button?.getAttribute("aria-label")).toBe("Document");
      // Named, not three dots: it holds the document's settings.
      expect(button?.querySelector(".label")?.textContent).toBe("Document");
      button?.click();
      expect(clicks).toEqual(["document"]);
    }
  });

  test("says where this browser's changes are, once it knows", () => {
    const { header, find } = setUp("edit");
    expect(find(".sync")).toBeNull();
    header.setSync("saved");
    expect(find(".sync")?.textContent?.trim()).toBe("Saved");
    header.setSync("sending");
    expect(find(".sync")?.textContent?.trim()).toBe("Sending…");
    header.setSync("offline");
    expect(find(".sync")?.textContent?.trim()).toBe(
      "Offline — kept on this device",
    );
    expect(find(".sync")?.dataset.state).toBe("offline");
  });

  test("holds the places of the modes and of the presence", () => {
    const { header, container } = setUp("edit");
    expect(container.contains(header.modes)).toBe(true);
    expect(container.contains(header.presence)).toBe(true);
  });

  // Analysis 18o.3, IC5: signed in, the name not carried yet — said in
  // the bar, and acted on from it.
  test("the identity not confirmed: a chip that acts; nothing otherwise", () => {
    const { header, find, clicks } = setUp("edit");
    expect(find(".identity-chip")).toBeNull();

    header.setIdentity("confirm");
    expect(find(".identity-chip")?.getAttribute("aria-label")).toBe(
      "Confirm your identity",
    );
    find(".identity-chip")?.click();
    header.setIdentity("unconfirmed");
    find(".identity-chip")?.click();
    expect(clicks).toEqual(["confirm", "unconfirmed"]);

    // What is to do at the home page, as it is (18p.2).
    for (const [chip, label] of [
      ["associate", "Your documents to associate"],
      ["open-here", "Open your list here"],
      ["other", "Another identity's documents"],
    ] as const) {
      header.setIdentity(chip);
      const home = find("a.identity-chip") as HTMLAnchorElement | null;
      expect(home?.href).toBe("https://collab.test/");
      expect(home?.target).toBe("_blank");
      expect(home?.getAttribute("aria-label")).toBe(label);
    }

    header.setIdentity(undefined);
    expect(find(".identity-chip")).toBeNull();
  });

  // IC5, precised (2026-10-30): signed out, the sign-in in the bar.
  test("signed out, a chip that signs in; signing in, one that cancels", () => {
    const { header, find, clicks } = setUp("read");
    header.setIdentity("sign-in");
    expect(find(".identity-chip")?.getAttribute("aria-label")).toBe("Sign in");
    find(".identity-chip")?.click();
    header.setIdentity("pending");
    expect(find(".identity-chip")?.getAttribute("aria-label")).toBe(
      "Signing in… · Cancel",
    );
    find(".identity-chip")?.click();
    expect(clicks).toEqual(["sign-in", "pending"]);
  });
});
