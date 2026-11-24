import { type SecretStore, secretId } from "./link-store.js";

/** Where the plugin reads and writes its `data.json`. */
export interface DataFile {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The view's `storage` in the plugin (docs/phase-14-plugin-obsidian.md,
 * decision 5): the keys in `kept` (the page's preferences) go to
 * `data.json`, under `preferences`, next to the plugin's other settings;
 * any other key — the edit secret pending a rotation (R-B4) — goes to
 * `app.secretStorage`, never to a file that git or a configuration sync
 * carries. */
export class PluginStorage implements Storage {
  private readonly items = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: DataFile,
    private readonly kept: readonly string[],
    private readonly secrets: SecretStore,
    private data: Record<string, unknown>,
  ) {
    const stored = isRecord(data.preferences) ? data.preferences : {};
    for (const key of kept) {
      const value = stored[key];
      if (typeof value === "string") this.items.set(key, value);
    }
  }

  static async load(
    file: DataFile,
    kept: readonly string[],
    secrets: SecretStore,
  ): Promise<PluginStorage> {
    const data = await file.loadData();
    return new PluginStorage(file, kept, secrets, isRecord(data) ? data : {});
  }

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (!this.kept.includes(key)) {
      // Emptied is removed: the secret store can't remove.
      return this.secrets.getSecret(secretId("storage", key)) || null;
    }
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (!this.kept.includes(key)) {
      this.secrets.setSecret(secretId("storage", key), String(value));
      return;
    }
    this.items.set(key, String(value));
    this.save();
  }

  removeItem(key: string): void {
    if (!this.kept.includes(key)) {
      this.secrets.setSecret(secretId("storage", key), "");
      return;
    }
    if (this.items.delete(key)) this.save();
  }

  /** The preferences; secrets stay (the page never clears its storage). */
  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.save();
  }

  /** A setting of the plugin's own, next to the preferences in
   * `data.json` (one writer for the file). */
  setting(name: string): unknown {
    return name === "preferences" ? undefined : this.data[name];
  }

  setSetting(name: string, value: unknown): void {
    if (name === "preferences") throw new Error("not a setting");
    this.data = { ...this.data, [name]: value };
    this.save();
  }

  /** Resolves once what was asked so far is written. */
  saved(): Promise<void> {
    return this.saving;
  }

  /** One write at a time, each with the preferences as they are then. */
  private save(): void {
    this.saving = this.saving.then(async () => {
      const preferences = Object.fromEntries(this.items);
      this.data = { ...this.data, preferences };
      try {
        await this.file.saveData(this.data);
      } catch (error) {
        console.warn("collab-link: preferences not saved", error);
      }
    });
  }
}
