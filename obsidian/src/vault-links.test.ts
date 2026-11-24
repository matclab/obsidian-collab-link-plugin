import type { App, TFile } from "obsidian";
// How a note's `[[…]]` resolve, and how a document is named back
// (docs/phase-19-liens.md, decisions 3 and 9): by Obsidian's
// metadataCache — a linked note's header names its document, the link
// store its server —, and the notes unlinked here, kept by the plugin.
import { describe, expect, test } from "vitest";
import { LinkStore } from "./link-store.js";
import { FakeApp } from "./test-support/obsidian.js";
import { fakeSecrets } from "./test-support/secrets.js";
import { UnlinkedNotes, vaultNames, vaultResolver } from "./vault-links.js";

const ORIGIN = "https://collab.test";
const KEY = "oN2yRZtq8mPQJ0SFGxDiWbQWXNLRT4u9zC5YZ1lJ3B0";
const linkOf = (id: string) =>
  `${ORIGIN}/?doc=${id}#k=${KEY}&r=edit.${"A".repeat(43)}`;
const header = (id: string) =>
  `---\ncollab-document: "${id}"\ncollab-version: ""\n---\n`;

async function vault() {
  const fake = new FakeApp();
  const app = fake as unknown as App;
  await fake.vault.create("Travail/A.md", `${header("a")}# A\n`);
  await fake.vault.create("Travail/B.md", `${header("b")}# B\n`);
  await fake.vault.create("C.md", "# C, ordinaire\n");
  await fake.vault.create("Vieux.md", "# Délié\n");
  const links = new LinkStore(fakeSecrets());
  links.set("a", linkOf("a"));
  links.set("b", linkOf("b"));
  const settings = new Map<string, unknown>();
  const unlinked = new UnlinkedNotes({
    setting: (name) => settings.get(name),
    setSetting: (name, value) => void settings.set(name, value),
  });
  const note = fake.vault.getAbstractFileByPath(
    "Travail/A.md",
  ) as unknown as TFile;
  return { app, links, unlinked, note };
}

describe("vaultResolver", () => {
  test("a linked note: its document and its server's page; this note: itself; else none", async () => {
    const { app, links, note } = await vault();
    const resolve = vaultResolver(app, note, links);
    expect(resolve("B")).toEqual({ documentId: "b", base: `${ORIGIN}/` });
    expect(resolve("Travail/B")).toEqual({
      documentId: "b",
      base: `${ORIGIN}/`,
    });
    expect(resolve("A")).toBe("self");
    expect(resolve("C")).toBeUndefined();
    expect(resolve("Absente")).toBeUndefined();
  });

  test("a linked note whose link isn't kept here: none", async () => {
    const { app, note } = await vault();
    expect(
      vaultResolver(app, note, new LinkStore(fakeSecrets()))("B"),
    ).toBeUndefined();
  });
});

describe("vaultNames", () => {
  test("a linked note's name, then a note unlinked here, else none", async () => {
    const { app, note, unlinked } = await vault();
    unlinked.note("v", "Vieux.md");
    unlinked.note("gone", "Supprimée.md");
    const nameOf = vaultNames(app, note, unlinked);
    expect(nameOf("b")).toBe("B");
    expect(nameOf("a")).toBe("A");
    expect(nameOf("v")).toBe("Vieux");
    expect(nameOf("gone")).toBeUndefined();
    expect(nameOf("z")).toBeUndefined();
  });
});

describe("UnlinkedNotes", () => {
  test("follows a rename, forgets a deletion, and is kept in the settings", async () => {
    const { unlinked } = await vault();
    unlinked.note("v", "Vieux.md");
    unlinked.renamed("Vieux.md", "Archives/Vieux.md");
    expect(unlinked.pathOf("v")).toBe("Archives/Vieux.md");
    unlinked.deleted("Archives/Vieux.md");
    expect(unlinked.pathOf("v")).toBeUndefined();
  });
});
