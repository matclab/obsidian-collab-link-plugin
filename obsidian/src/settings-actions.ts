import {
  type App,
  Notice,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "obsidian";
import { fetchPageConfig, t } from "../../web/src/embed.js";
import type { PluginSettings } from "./plugin-settings.js";
import type { PluginStorage } from "./plugin-storage.js";
import { checkCredentials, creationFetch } from "./server.js";
import { TrustModal } from "./trust-modal.js";

type Request = (param: RequestUrlParam) => Promise<RequestUrlResponse>;

/** « Tester le nom et le mot de passe »: said in a notice, nothing created. */
export async function testCredentials(
  settings: PluginSettings,
  request: Request,
): Promise<void> {
  const server = settings.serverChosen();
  if (!server.ok) {
    new Notice(server.notice);
    return;
  }
  const checked = await checkCredentials(
    server.origin,
    request,
    settings.auth(),
  );
  new Notice(
    {
      accepted: t().pluginCredentialsAccepted,
      refused: t().pluginCredentialsRefused,
      missing: t().pluginCredentialsMissing,
      "not-asked": t().pluginCredentialsNotAsked,
      unreachable: t().pluginServerUnreachable(server.origin),
    }[checked],
  );
}

/** « Lire depuis le serveur » (M3): what the server's `/config.json`
 * names, kept only once the user confirmed it. */
export async function readFromServer(
  app: App,
  settings: PluginSettings,
  storage: PluginStorage,
  request: Request,
): Promise<boolean> {
  const server = settings.serverChosen();
  if (!server.ok) {
    new Notice(server.notice);
    return false;
  }
  const config = await fetchPageConfig(
    server.origin,
    creationFetch(request, undefined),
  );
  if (!config) {
    new Notice(t().pluginServerUnreadable(server.origin));
    return false;
  }
  if (!config.attestationKeys) {
    new Notice(t().pluginServerNamesNoGateway);
    return false;
  }
  const confirmed = await new Promise<boolean>((resolve) =>
    new TrustModal(app, config, resolve).open(),
  );
  if (!confirmed) return false;
  storage.setSetting("gateway", config.gateway ?? "");
  storage.setSetting("attestationKeys", config.attestationKeys.join("\n"));
  storage.setSetting("orgName", config.orgName ?? "");
  return true;
}
