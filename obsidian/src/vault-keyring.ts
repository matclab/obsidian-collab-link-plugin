import {
  type App,
  Notice,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "obsidian";
import { createKeyring } from "../../web/lib/src/index.js";
import {
  type DocumentLock,
  type DocumentTarget,
  type IdentityKeys,
  type KeyringEnvironment,
  type KeyringLock,
  KeyringSession,
  PSEUDONYM_KEY,
  documentIdentity,
  identityKeys,
  mountHome,
  openDeviceKeyStore,
  openKeyringLocal,
  sessionOptions,
  t,
} from "../../web/src/embed.js";
import { DocumentsModal } from "./documents-modal.js";
import type { SecretStore } from "./link-store.js";
import type { PluginSettings } from "./plugin-settings.js";
import type { PluginStorage } from "./plugin-storage.js";
import { deviceSealKey } from "./seal-key.js";
import { requestFetch } from "./server.js";

/** A channel between the windows of the vault (`BroadcastChannel`, the origin
 * `app://obsidian.md` being theirs): the sign-in's return reaches the one whose
 * attempt it is, wherever Obsidian delivered it; another vault's are apart. */
export function vaultChannel(vault: string, name: string) {
  const channel = new BroadcastChannel(`collab-link:${vault}:${name}`);
  return {
    post: (data: unknown) => channel.postMessage(data),
    listen: (listener: (data: unknown) => void) => {
      const handle = (event: MessageEvent) => listener(event.data);
      channel.addEventListener("message", handle);
      return () => channel.removeEventListener("message", handle);
    },
  };
}

/** What the keyring needs of the plugin. */
export interface KeyringHost {
  app: App;
  settings: PluginSettings;
  storage: PluginStorage;
  secrets: SecretStore;
  /** Where documents are kept on the device (ADR-0022). */
  localStore(): {
    indexedDB?: IDBFactory;
    lock?: DocumentLock;
    keyringLock?: KeyringLock;
  };
  request(param: RequestUrlParam): Promise<RequestUrlResponse>;
  setTimer(run: () => void, ms: number): () => void;
  /** Opens an address in the system's browser. */
  openExternal(url: string): void;
  /** This vault's records, apart from other vaults'. */
  vaultId(): string;
  track<T>(work: Promise<T>): Promise<T>;
  /** Opens a link's document in its note, a failure said. */
  openPasted(link: string): Promise<void>;
  /** « Mes documents » shown: its tab, or a new one. */
  showMyDocuments(): Promise<void>;
}

/** The vault's « Mes documents » (M1, M2), on the server of the settings, its
 * secrets sealed by the device's key; none without IndexedDB, locks or a
 * server. Built again when the server changes. Its session, one for the vault's
 * views (M7), and the key they sign with. */
export class VaultKeyring {
  private keyringOf:
    | { server: string; env: Promise<KeyringEnvironment | undefined> }
    | undefined;
  /** Its session; replaced by an association with the identity. */
  private session: Promise<KeyringSession | undefined> =
    Promise.resolve(undefined);
  /** The key the views sign with, once Ed25519 is known (M7). */
  private identity: Promise<IdentityKeys | undefined> =
    Promise.resolve(undefined);
  /** Documents just created by a share: their first view says so to the
   * keyring (KR-24). */
  private readonly justShared = new Set<string>();
  /** The list « Ouvrir un document de Mes documents » shows (tests). */
  suggesting: DocumentsModal | undefined;

  constructor(private readonly host: KeyringHost) {}

  /** The key the views sign with, once `canSign` says Ed25519 is there. */
  followIdentity(canSign: Promise<boolean>): void {
    this.identity = canSign.then((can) => {
      const { indexedDB } = this.host.localStore();
      return can && indexedDB
        ? identityKeys({
            device: openDeviceKeyStore(indexedDB, this.host.vaultId()),
            keyring: () => this.session,
          })
        : undefined;
    });
  }

  /** `documentId` was just created by a share (KR-24). */
  shared(documentId: string): void {
    this.justShared.add(documentId);
  }

  /** The session closed, the plugin unloaded. */
  close(): void {
    void this.session.then((session) => session?.close());
  }

  /** M1, M2: the vault's keyring on the server of the settings, its
   * session opened; built again, and the session too, once that server
   * changed (OB4: what is open keeps its server until then). */
  ensure(): Promise<KeyringEnvironment | undefined> {
    const server = this.host.settings.serverSet();
    const { indexedDB, keyringLock } = this.host.localStore();
    const secrets = this.host.secrets;
    if (!server || !indexedDB || !keyringLock) {
      return Promise.resolve(undefined);
    }
    if (this.keyringOf?.server === server) return this.keyringOf.env;
    const vault = this.host.vaultId();
    const env = deviceSealKey(secrets, keyringLock)
      .then((sealKey): KeyringEnvironment => {
        const local = openKeyringLocal({
          indexedDB,
          lock: keyringLock,
          namespace: vault,
          sealKey,
        });
        return {
          local,
          fetch: requestFetch((param) => this.host.request(param)),
          setTimer: (run, ms) => this.host.setTimer(run, ms),
          // Signing in by the system's browser (ADR-0041, point 7).
          ...(typeof BroadcastChannel === "function" && {
            account: {
              local,
              openWindow: (url: string) => this.host.openExternal(url),
              channel: (name: string) => vaultChannel(vault, name),
              client: "obsidian" as const,
            },
          }),
        };
      })
      .catch(() => undefined);
    this.keyringOf = { server, env };
    this.reopenSession();
    return env;
  }

  /** The vault's session opened again: « Mes documents » changed (kept,
   * found, joined, associated), or its server. */
  reopenSession(): Promise<KeyringSession | undefined> {
    const previous = this.session;
    const opened = this.keyringOf;
    this.session = opened
      ? opened.env
          .then((env) =>
            env
              ? KeyringSession.open(sessionOptions(env, opened.server))
              : undefined,
          )
          .catch(() => undefined)
      : Promise.resolve(undefined);
    void previous.then((session) => session?.close());
    return this.session;
  }

  /** The session now, as it is opened. */
  current(): Promise<KeyringSession | undefined> {
    return this.session;
  }

  /** « Mes documents » of the vault (M5): the page's home, or why not. */
  async mount(root: HTMLElement) {
    const { app, settings } = this.host;
    const server = settings.serverSet();
    if (!server) return t().pluginNoServer;
    const keyring = await this.ensure();
    if (!keyring) return t().pluginNoMyDocuments;
    const trust = settings.trust();
    return mountHome(root, {
      apiBase: server,
      keyring,
      createKeyring: () =>
        createKeyring(
          server,
          requestFetch((param) => this.host.request(param), settings.auth()),
        ),
      confirm: (message) => window.confirm(message),
      copy: (text) => navigator.clipboard.writeText(text),
      now: () => Date.now(),
      newDocument: false,
      openEntry: (link) => this.host.track(this.host.openPasted(link)),
      // OB3: what the settings trust, else no gateway at all.
      config: trust ?? {},
      onKeyringChanged: () => void this.reopenSession(),
      // What awaits my reply in the recent documents (ADR-0060 §2), while
      // the tab is shown in Obsidian's focused window.
      awaiting: {
        indexedDB: this.host.localStore().indexedDB,
        namespace: this.host.vaultId(),
        pseudonym: () => this.host.storage.getItem(PSEUDONYM_KEY) ?? "",
        visible: () =>
          root.isConnected &&
          root.ownerDocument.hasFocus() &&
          root.offsetParent !== null,
        onVisible: (listener) => {
          const view = root.ownerDocument.defaultView ?? window;
          view.addEventListener("focus", listener);
          const ref = app.workspace.on("active-leaf-change", listener);
          return () => {
            view.removeEventListener("focus", listener);
            app.workspace.offref(ref);
          };
        },
        setTimer: (run, ms) => this.host.setTimer(run, ms),
      },
    });
  }

  /** « Ouvrir un document de Mes documents » (M6). */
  async choose(): Promise<void> {
    await this.ensure();
    // Kept meanwhile in another window, perhaps.
    const session = (await this.session) ?? (await this.reopenSession());
    if (!session) {
      new Notice(t().pluginMyDocumentsEmpty);
      return;
    }
    const modal = new DocumentsModal(
      this.host.app,
      () => session.entries(),
      (entry) => void this.host.track(this.host.openPasted(entry.link)),
    );
    this.suggesting = modal;
    modal.open();
  }

  /** What a view of `documentId` is given (M7): the vault's keyring, its
   * key, and the trust of the settings — none without (OB3); the list seen
   * to in the vault's « Mes documents », never the browser's. */
  async documentIdentity(
    documentId: string,
    apiBase: string,
  ): Promise<Partial<DocumentTarget>> {
    const { settings } = this.host;
    const [keyring, identity] = await Promise.all([
      this.ensure(),
      this.identity,
    ]);
    const trust = settings.trust();
    const server = settings.serverSet();
    const target = await documentIdentity({
      apiBase,
      documentId,
      created: this.justShared.delete(documentId),
      now: () => Date.now(),
      session: () => this.session,
      replaceSession: (next) => {
        this.session = Promise.resolve(next);
      },
      ...(keyring && { keyring }),
      // The list in waiting (LA1), at the server its session reads it from.
      createKeyring: () =>
        createKeyring(
          apiBase,
          requestFetch((param) => this.host.request(param), settings.auth()),
        ),
      ...(identity && { identity }),
      ...(trust && {
        fetch: requestFetch((param) => this.host.request(param)),
        setTimer: (run, ms) => this.host.setTimer(run, ms),
        trusted: {
          config: trust,
          // Where the gateway pushes its list (§6.9).
          apiBase: server ?? apiBase,
        },
      }),
    });
    return {
      ...target,
      openHome: () => void this.host.track(this.host.showMyDocuments()),
    };
  }
}
