import {
  Notice,
  Plugin,
  type RequestUrlParam,
  type RequestUrlResponse,
  type TAbstractFile,
  TFile,
  getLanguage,
  requestUrl,
} from "obsidian";
import {
  OBSIDIAN_RETURN_ACTION,
  openLink,
  readObsidianReturn,
} from "../../web/lib/src/index.js";
import {
  type DocumentLock,
  type KeyringLock,
  LANGUAGE_KEY,
  PREFERENCE_KEYS,
  SIGN_IN_CHANNEL,
  chooseLanguage,
  openDocument,
  setLanguage,
  t,
  webKeyringLock,
  webLocks,
} from "../../web/src/embed.js";
import { Addresses } from "./addresses.js";
import { addCommands } from "./commands.js";
import type { DocumentsModal } from "./documents-modal.js";
import { ed25519Supported } from "./ed25519.js";
import { EXPORT_DELAY_MS } from "./exporter.js";
import {
  DOCUMENT_VIEW,
  DocumentLeafView,
  type ViewHost,
  obsidianEnvironment,
} from "./leaf-view.js";
import { LinkStore, secretId, withFormerIds } from "./link-store.js";
import { LinkedNotes } from "./linked-notes.js";
import { LiveViews } from "./live-views.js";
import { MY_DOCUMENTS_VIEW, MyDocumentsView } from "./my-documents-view.js";
import { VaultNotes } from "./notes.js";
import { ObsidianEditors, obsidianEditorClass } from "./obsidian-editor.js";
import {
  followAddresses,
  followObsidianOptions,
  openLinkedNotesInTheView,
} from "./obsidian-patches.js";
import { PluginSettings } from "./plugin-settings.js";
import { PluginStorage } from "./plugin-storage.js";
import { requestFetch } from "./server.js";
import { readFromServer, testCredentials } from "./settings-actions.js";
import { CollabLinkSettings } from "./settings-tab.js";
import { share } from "./sharing.js";
import type { TrustSettings } from "./trust-settings.js";
import { typedLinks } from "./typed-links.js";
import { VaultKeyring, vaultChannel } from "./vault-keyring.js";
import { UnlinkedNotes, vaultNames, vaultResolver } from "./vault-links.js";
import type { Rename } from "./wikilinks.js";

/** How many renames are kept for their links' rewrite. */
const RENAMES_KEPT = 32;

/** The window's timers, as the keyring, the trust and the views take
 * them. */
function windowTimer(run: () => void, ms: number): () => void {
  const timer = window.setTimeout(run, ms);
  return () => window.clearTimeout(timer);
}

/** Collab Link (docs/phase-14-plugin-obsidian.md): a client of the
 * protocol in Obsidian. A linked note opens in a view of the plugin's,
 * the page's own; its file is the export of its document. Here, the
 * wiring: each part in its module, given what it needs of the others. */
export default class CollabLink extends Plugin {
  /** How a view opens its document; a test's fake server replaces it. */
  openDocument: typeof openDocument = openDocument;
  /** Obsidian's `requestUrl`; a test's fake server. */
  request: (param: RequestUrlParam) => Promise<RequestUrlResponse> = (param) =>
    requestUrl(param);
  /** The brief connection of a share; a test's fake. */
  connect: typeof openLink = (url, options) => openLink(url, options);
  /** Whether this Obsidian has Ed25519; a test's answer. */
  ed25519: () => Promise<boolean> = () => ed25519Supported();
  /** Ed25519's answer, once loaded: nothing is signed without it. */
  canSign: Promise<boolean> = Promise.resolve(false);
  /** The export's delay; a test shortens it. */
  exportDelayMs = EXPORT_DELAY_MS;
  /** The plugin's timers; a test's, counted (AGENTS.md §1.6). */
  setTimer: (run: () => void, ms: number) => () => void = windowTimer;
  /** Where documents are kept on the device (ADR-0022): Obsidian's
   * IndexedDB and Web Locks; a test's fakes. */
  localStore: {
    indexedDB?: IDBFactory;
    lock?: DocumentLock;
    /** « Mes documents »'s, waiting its turn (M2). */
    keyringLock?: KeyringLock;
  } = {
    indexedDB: globalThis.indexedDB,
    ...(globalThis.navigator?.locks && {
      lock: webLocks(globalThis.navigator.locks),
      keyringLock: webKeyringLock(globalThis.navigator.locks),
    }),
  };
  /** Opens an address in the system's browser (the sign-in, ADR-0041
   * point 7): Obsidian sends a window's web address there. A test's. */
  openExternal: (url: string) => void = (url) => void window.open(url);
  private storage: PluginStorage | undefined;
  private readSettings: PluginSettings | undefined;
  private keyring: VaultKeyring | undefined;
  /** The notes renamed lately, newest last: the rewrite of the links to
   * them is recognized (ADR-0045). */
  private readonly renames: Rename[] = [];
  /** What was asked and still runs (`track`), each on its own: none
   * waits for another, `settled` for all. */
  private readonly running = new Set<Promise<void>>();
  /** The live view of each document. */
  private readonly views = new LiveViews<DocumentLeafView>();
  /** Obsidian's editors in the views (ADR-0039), once looked for; null: not
   * found. */
  private editors: ObsidianEditors | null | undefined;

  /** The list « Ouvrir un document de Mes documents » shows (tests). */
  get suggesting(): DocumentsModal | undefined {
    return this.keyring?.suggesting;
  }

  override async onload(): Promise<void> {
    // Under the plugin's former name too.
    const secrets = withFormerIds(this.app.secretStorage);
    const storage = await PluginStorage.load(this, PREFERENCE_KEYS, secrets);
    this.storage = storage;
    const settings = new PluginSettings(storage, secrets);
    this.readSettings = settings;
    const links = new LinkStore(secrets);
    const unlinked = new UnlinkedNotes(storage);
    const { app, views } = this;
    const track = <T>(work: Promise<T>) => this.track(work);
    const request = this.requestOf();
    // The vault's linked notes, kept as it changes (LN1–LN3).
    const index = new LinkedNotes(this.app.vault);
    const looked = (file: TAbstractFile) => {
      if (file instanceof TFile) index.look(file);
    };
    // Once the layout is ready: before, Obsidian tells a `create` of each
    // file already there.
    app.workspace.onLayoutReady(() => {
      index.start();
      this.registerEvent(app.vault.on("create", looked));
    });
    this.registerEvent(app.vault.on("modify", looked));
    this.registerEvent(
      app.vault.on("rename", (file, from) => {
        if (file instanceof TFile) index.renamed(file, from);
      }),
    );
    this.registerEvent(
      app.vault.on("delete", (file) => index.forget(file.path)),
    );
    const notes = new VaultNotes({
      app,
      settings,
      storage,
      links,
      views,
      index,
      track,
    });
    const keyring = new VaultKeyring({
      app,
      settings,
      storage,
      secrets,
      localStore: () => this.localStore,
      request,
      setTimer: (run, ms) => this.setTimer(run, ms),
      openExternal: (url) => this.openExternal(url),
      vaultId: () => this.vaultId(),
      track,
      openPasted: (link) => notes.openPasted(link),
      showMyDocuments: () => this.showMyDocuments(),
    });
    this.keyring = keyring;
    const addresses = new Addresses({
      app,
      settings,
      unlinked,
      notes,
      keyring,
      track,
    });
    this.applyLanguage();
    this.canSign = this.ed25519().catch(() => false);
    const telling = this.canSign.then((can) => {
      // Said once, as the missing system keyring.
      if (can || storage.setting("toldNoEd25519") === true) return;
      storage.setSetting("toldNoEd25519", true);
      new Notice(t().pluginNoEd25519);
    });
    this.track(telling);
    void keyring.ensure();
    keyring.followIdentity(this.canSign);
    this.register(() => keyring.close());
    // ID-41: the sign-in's return, from the system's browser. Passed to
    // every window of the vault, where only its attempt takes it (OB1).
    this.registerObsidianProtocolHandler(OBSIDIAN_RETURN_ACTION, (params) => {
      const read = readObsidianReturn(params);
      if (read) vaultChannel(this.vaultId(), SIGN_IN_CHANNEL).post({ ...read });
    });
    const host: ViewHost = {
      links,
      environment: () =>
        obsidianEnvironment({
          storage,
          open: (options) => this.openDocument(options),
          vault: this.vaultId(),
          indexedDB: this.localStore.indexedDB,
          lock: this.localStore.lock,
          fetch: requestFetch(request, settings.auth()),
        }),
      applyLanguage: () => this.applyLanguage(),
      documentIdentity: (documentId, apiBase) =>
        keyring.documentIdentity(documentId, apiBase),
      editorFor: (note) => {
        if (storage.setting("editor") === "page") return undefined;
        const editors = this.obsidianEditors(links);
        return editors ? editors.factory(note) : "unavailable";
      },
      exportDelayMs: () => this.exportDelayMs,
      setTimer: (run, ms) => this.setTimer(run, ms),
      views,
      workspace: {
        reveal: (leaf) => {
          app.workspace.setActiveLeaf(leaf, { focus: true });
        },
        isActive: (leaf) =>
          app.workspace.getActiveViewOfType(DocumentLeafView)?.leaf === leaf,
        onActiveLeafChange: (listener) => {
          const ref = app.workspace.on("active-leaf-change", listener);
          return () => app.workspace.offref(ref);
        },
      },
      notes,
      vaultLinks: {
        renames: () => this.renames,
        resolverFor: (note) => vaultResolver(app, note, links),
        namesFor: (note) => vaultNames(app, note, unlinked),
        noteUnlinked: (documentId, note) =>
          unlinked.note(documentId, note.path),
      },
      images: {
        inVault: () => settings.imagesInVault(),
        folder: () => settings.folder(),
      },
    };
    // Obsidian opens every address by `window.open`; one of this server's
    // documents, without its key, is opened here instead (ADR-0045).
    followAddresses(
      (undo) => this.register(undo),
      (href, open) => addresses.follow(href, open),
    );
    // A note renamed — its rewrite of the links to it recognized, an
    // unlinked note followed (ADR-0045).
    this.registerEvent(
      app.vault.on("rename", (file, from) => {
        unlinked.renamed(from, file.path);
        this.renames.push({ from, to: file.path });
        if (this.renames.length > RENAMES_KEPT) this.renames.shift();
      }),
    );
    this.registerEvent(
      app.vault.on("delete", (file) => unlinked.deleted(file.path)),
    );
    // A linked note's file changed — by the export, or from outside —:
    // its live view looks.
    this.registerEvent(
      app.vault.on("modify", (file) => {
        for (const view of views.all()) {
          if (view.file === file) void view.fileChanged();
        }
      }),
    );
    this.registerView(
      DOCUMENT_VIEW,
      (leaf) => new DocumentLeafView(leaf, host),
    );
    openLinkedNotesInTheView(
      app,
      (undo) => this.register(undo),
      (file) => notes.isLinked(file),
    );
    followObsidianOptions(
      app,
      (undo) => this.register(undo),
      () => this.editors?.updateOptions(),
    );
    // « Mes documents » of the vault (M5, M6).
    this.registerView(
      MY_DOCUMENTS_VIEW,
      (leaf) =>
        new MyDocumentsView(leaf, { mountHome: (root) => keyring.mount(root) }),
    );
    addCommands(this, {
      app,
      track,
      openPasted: (text) => notes.openPasted(text),
      showMyDocuments: () => this.showMyDocuments(),
      chooseFromMyDocuments: () => keyring.choose(),
      share: (file) =>
        share(
          {
            app,
            settings,
            storage,
            links,
            views,
            unlinked,
            index,
            request,
            connect: (url, options) => this.connect(url, options),
            shared: (documentId) => keyring.shared(documentId),
            sayIfNoKeyring: () => notes.sayIfNoKeyring(),
          },
          file,
        ),
    });
    const password = secretId("setting", "password");
    const text = (name: string) => ({
      get: () => {
        const value = storage.setting(name);
        return typeof value === "string" ? value : "";
      },
      set: (value: string) => storage.setSetting(name, value),
    });
    this.addSettingTab(
      new CollabLinkSettings(this.app, this, {
        server: text("server"),
        user: text("user"),
        // In the secret storage, never in data.json.
        password: {
          get: () => secrets.getSecret(password) ?? "",
          set: (value) => secrets.setSecret(password, value),
        },
        folder: {
          get: () => settings.folder(),
          set: (folder) => storage.setSetting("folder", folder),
        },
        // ADR-0058 §2: on by default; the open views export again.
        images: {
          get: () => settings.imagesInVault(),
          set: (on) => {
            storage.setSetting("vaultImages", on);
            for (const view of this.views.all()) view.imagesChanged();
          },
        },
        // Read when a view opens.
        editor: {
          get: () =>
            storage.setting("editor") === "page" ? "page" : "obsidian",
          set: (editor) => storage.setSetting("editor", editor),
        },
        // M3: public, in data.json.
        gateway: text("gateway"),
        attestationKeys: text("attestationKeys"),
        checkCredentials: () =>
          this.track(testCredentials(settings, this.requestOf())),
        readFromServer: () =>
          this.track(
            readFromServer(this.app, settings, storage, this.requestOf()),
          ),
      }),
    );
  }

  /** What the plugin trusts of a gateway: its settings (M3, OB3). */
  trust(): TrustSettings | undefined {
    return this.readSettings?.trust();
  }

  /** The plugin's requests, by `request` as it is when they are made. */
  private requestOf(): (param: RequestUrlParam) => Promise<RequestUrlResponse> {
    return (param) => this.request(param);
  }

  /** `work`, waited for by `settled`. */
  private track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.then(
      () => {},
      () => {},
    );
    this.running.add(tracked);
    void tracked.finally(() => this.running.delete(tracked));
    return work;
  }

  /** Resolves once what was asked so far has its note and tab (tests). */
  async settled(): Promise<void> {
    await Promise.all(this.running);
    await this.storage?.saved();
  }

  /** The language chosen in a view, else Obsidian's. */
  applyLanguage(): void {
    setLanguage(
      chooseLanguage(this.storage?.getItem(LANGUAGE_KEY), [getLanguage()]),
    );
  }

  /** This vault's records, apart from other vaults'. */
  private vaultId(): string {
    const { appId } = this.app as unknown as { appId?: unknown };
    return typeof appId === "string" ? appId : this.app.vault.getName();
  }

  /** « Mes documents » shown: its tab, or a new one. */
  private async showMyDocuments(): Promise<void> {
    const [open] = this.app.workspace.getLeavesOfType(MY_DOCUMENTS_VIEW);
    if (open) {
      this.app.workspace.setActiveLeaf(open, { focus: true });
      return;
    }
    await this.app.workspace
      .getLeaf("tab")
      .setViewState({ type: MY_DOCUMENTS_VIEW, active: true });
  }

  /** Obsidian's editors, looked for once (ADR-0039). */
  private obsidianEditors(links: LinkStore): ObsidianEditors | null {
    if (this.editors === undefined) {
      const found = obsidianEditorClass(this.app);
      this.editors = found
        ? new ObsidianEditors(this.app, this, found, (note) => [
            // A `[[B]]` typed, B a linked note (LK6).
            typedLinks(() => {
              const file = note();
              return file ? vaultResolver(this.app, file, links) : undefined;
            }),
          ])
        : null;
    }
    return this.editors;
  }
}
