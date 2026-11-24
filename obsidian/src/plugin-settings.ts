import { t } from "../../web/src/embed.js";
import { type SecretStore, secretId } from "./link-store.js";
import type { PluginStorage } from "./plugin-storage.js";
import { serverOrigin } from "./server.js";
import { type TrustSettings, trustSettings } from "./trust-settings.js";

const DEFAULT_FOLDER = "Collab Link";

/** The plugin's settings, as its parts read them: in `data.json`, the password
 * in the secrets. */
export class PluginSettings {
  constructor(
    private readonly storage: PluginStorage,
    private readonly secrets: SecretStore,
  ) {}

  /** The server of the settings, if usable. */
  serverSet(): string | undefined {
    const server = this.serverChosen();
    return server.ok ? server.origin : undefined;
  }

  /** The server of the settings, or what to say: none set, or unusable. */
  serverChosen(): { ok: true; origin: string } | { ok: false; notice: string } {
    const setting = this.storage.setting("server");
    if (typeof setting !== "string" || setting.trim() === "") {
      return { ok: false, notice: t().pluginNoServer };
    }
    const server = serverOrigin(setting);
    return server.ok
      ? { ok: true, origin: server.origin }
      : { ok: false, notice: t().pluginBadServer };
  }

  /** The name and password of the settings, if a name is set: sent with what
   * creates, a document or « Mes documents ». */
  auth(): { user: string; password: string } | undefined {
    const user = this.storage.setting("user");
    const password =
      this.secrets.getSecret(secretId("setting", "password")) ?? "";
    return typeof user === "string" && user !== ""
      ? { user, password }
      : undefined;
  }

  /** What the plugin trusts of a gateway: its settings (M3, OB3). */
  trust(): TrustSettings | undefined {
    return trustSettings((name) => this.storage.setting(name));
  }

  /** Whether attached images are written to the vault (ADR-0058 §2). */
  imagesInVault(): boolean {
    return this.storage.setting("vaultImages") !== false;
  }

  /** Where opened links get their note. */
  folder(): string {
    const folder = this.storage.setting("folder");
    return typeof folder === "string" ? folder : DEFAULT_FOLDER;
  }
}
