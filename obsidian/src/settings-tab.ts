import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";
import { t } from "../../web/src/embed.js";
import { readFingerprints } from "./trust-settings.js";

/** A setting: read when shown, written as typed. */
export interface SettingValue {
  get(): string;
  set(value: string): void;
}

/** The plugin's settings: the server documents are created on, and its name and
 * password if it asks, tested on demand; where "Open a link" creates notes; the
 * identity gateway and the attestation keys' fingerprints (M3), typed or read
 * from the server once confirmed. */
export class CollabLinkSettings extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly values: {
      server: SettingValue;
      user: SettingValue;
      password: SettingValue;
      folder: SettingValue;
      /** "obsidian" or "page". */
      editor: SettingValue;
      /** Attached images written to the vault (ADR-0058 §2). */
      images: { get(): boolean; set(on: boolean): void };
      gateway: SettingValue;
      attestationKeys: SettingValue;
      /** Tests the name and password with the server, and says so. */
      checkCredentials(): Promise<void>;
      /** Asks the server, then the user; resolves `true` if the settings
       * changed. */
      readFromServer(): Promise<boolean>;
    },
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.replaceChildren();
    const field = (
      name: string,
      description: string,
      value: SettingValue,
      password = false,
    ) =>
      new Setting(this.containerEl)
        .setName(name)
        .setDesc(description)
        .addText((text) => {
          if (password) text.inputEl.type = "password";
          text.setValue(value.get()).onChange((next) => value.set(next));
        });
    field(t().pluginServer, t().pluginServerDescription, this.values.server);
    field(t().pluginUser, t().pluginUserDescription, this.values.user);
    field(
      t().pluginPassword,
      t().pluginPasswordDescription,
      this.values.password,
      true,
    );
    new Setting(this.containerEl)
      .setName(t().pluginCheckCredentials)
      .setDesc(t().pluginCheckCredentialsDescription)
      .addButton((button) =>
        button
          .setButtonText(t().pluginCheckCredentialsButton)
          .onClick(() => void this.values.checkCredentials()),
      );
    field(t().pluginFolder, t().pluginFolderDescription, this.values.folder);
    new Setting(this.containerEl)
      .setName(t().pluginEditor)
      .setDesc(t().pluginEditorDescription)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("obsidian", t().pluginEditorObsidian)
          .addOption("page", t().pluginEditorPage)
          .setValue(this.values.editor.get())
          .onChange((next) => this.values.editor.set(next)),
      );
    new Setting(this.containerEl)
      .setName(t().pluginVaultImages)
      .setDesc(t().pluginVaultImagesDescription)
      .addToggle((toggle) =>
        toggle
          .setValue(this.values.images.get())
          .onChange((on) => this.values.images.set(on)),
      );
    new Setting(this.containerEl).setName(t().pluginIdentity).setHeading();
    field(t().pluginGateway, t().pluginGatewayDescription, this.values.gateway);
    const keys = new Setting(this.containerEl)
      .setName(t().pluginAttestationKeys)
      .setDesc(t().pluginAttestationKeysDescription);
    const said = (text: string) => {
      const read = readFingerprints(text);
      keys.descEl.textContent = read.ok
        ? t().pluginAttestationKeysDescription
        : `${t().pluginAttestationKeysDescription} ${t().pluginAttestationKeysBad(read.line)}`;
    };
    keys.addTextArea((area) =>
      area.setValue(this.values.attestationKeys.get()).onChange((next) => {
        this.values.attestationKeys.set(next);
        said(next);
      }),
    );
    said(this.values.attestationKeys.get());
    new Setting(this.containerEl)
      .setName(t().pluginReadFromServer)
      .setDesc(t().pluginReadFromServerDescription)
      .addButton((button) =>
        button.setButtonText(t().pluginReadFromServerButton).onClick(() => {
          void this.values.readFromServer().then((changed) => {
            if (changed) this.display();
          });
        }),
      );
  }
}
