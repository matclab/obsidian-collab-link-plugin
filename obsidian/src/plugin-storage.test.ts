// What the view keeps in its `storage` (docs/phase-14-plugin-obsidian.md,
// decision 5): the preferences in the plugin's `data.json`, which git and
// a configuration sync carry; anything else — the edit secret pending a
// rotation (R-B4) — in `app.secretStorage`, never there.
import { beforeEach, describe, expect, test } from "vitest";
import { PluginStorage } from "./plugin-storage.js";
import { fakeSecrets } from "./test-support/secrets.js";

/** The plugin's `loadData`/`saveData`, over a `data.json` in memory. */
function dataFile(initial: unknown = null) {
  const file = { data: initial, saves: 0 };
  return {
    file,
    host: {
      loadData: async () => structuredClone(file.data),
      saveData: async (data: unknown) => {
        file.saves++;
        file.data = structuredClone(data);
      },
    },
  };
}

const KEPT = ["pref:name", "pref:language"];
let secrets = fakeSecrets();
beforeEach(() => {
  secrets = fakeSecrets();
});

describe("the plugin's storage", () => {
  test("a preference is in data.json, and there again at the next start", async () => {
    const { host } = dataFile();
    const storage = await PluginStorage.load(host, KEPT, secrets);
    storage.setItem("pref:name", "alice");
    await storage.saved();

    const next = await PluginStorage.load(host, KEPT, secrets);
    expect(next.getItem("pref:name")).toBe("alice");
  });

  test("anything else goes to the secret store: never to data.json, and there at the next start", async () => {
    const { host, file } = dataFile();
    const storage = await PluginStorage.load(host, KEPT, secrets);
    storage.setItem("obsidian-collab:pending:doc", "a-secret");
    await storage.saved();

    expect(storage.getItem("obsidian-collab:pending:doc")).toBe("a-secret");
    expect(file.saves).toBe(0);
    expect(JSON.stringify(file.data ?? {})).not.toContain("a-secret");
    expect([...secrets.values.values()]).toEqual(["a-secret"]);
    const next = await PluginStorage.load(host, KEPT, secrets);
    expect(next.getItem("obsidian-collab:pending:doc")).toBe("a-secret");
    next.removeItem("obsidian-collab:pending:doc");
    expect(next.getItem("obsidian-collab:pending:doc")).toBeNull();
  });

  test("removing a preference removes it from data.json; the file's other settings stay", async () => {
    const { host, file } = dataFile({
      server: "https://collab.test",
      preferences: { "pref:language": "fr" },
    });
    const storage = await PluginStorage.load(host, KEPT, secrets);
    expect(storage.getItem("pref:language")).toBe("fr");
    storage.removeItem("pref:language");
    await storage.saved();

    expect(file.data).toEqual({
      server: "https://collab.test",
      preferences: {},
    });
  });

  test("a data.json it can't read is an empty storage, not an error", async () => {
    for (const data of [
      null,
      3,
      "x",
      [],
      { preferences: 3 },
      { preferences: { "pref:name": 4 } },
    ]) {
      const { host } = dataFile(data);
      const storage = await PluginStorage.load(host, KEPT, secrets);
      expect(storage.getItem("pref:name")).toBeNull();
      expect(storage.length).toBe(0);
    }
  });

  test("a key it holds back from data.json is never read from it either", async () => {
    const { host } = dataFile({
      preferences: { "obsidian-collab:pending:doc": "s" },
    });
    const storage = await PluginStorage.load(host, KEPT, secrets);
    expect(storage.getItem("obsidian-collab:pending:doc")).toBeNull();
  });
});
