import type { LoroDoc } from "loro-crdt";
import {
  ConnectionRefused,
  type LinkFragment,
  type OpenedImage,
  type Role,
  type documentLinks,
  importKeyFromBase64Url,
  mayPublish,
} from "../../lib/src/index.js";
import type { PageConfig } from "../account/config.js";
import type { Trust } from "../account/trust.js";
import { type EditorFactory, makeReadOnly } from "../editor/editor.js";
import {
  FORMATTING_KEY,
  storedFormatting,
} from "../editor/formatting-preference.js";
import { moveSectionBy } from "../editor/section-commands.js";
import { LANGUAGE_KEY, currentLanguage, t } from "../i18n/index.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import {
  PSEUDONYM_KEY,
  authorOf,
  ensurePseudonym,
  savePseudonym,
  storedPseudonym,
} from "../identity/pseudonym.js";
import type { DocumentAssociation } from "../keyring/document-association.js";
import type { DocumentKeyring } from "../keyring/hooks.js";
import type { HeadingTarget } from "../outline/resolve.js";
import { counters, enableMarks, measureSince, timings } from "../perf/index.js";
import type { DevicePush } from "../push/device.js";
import type { DocumentLock } from "../storage/index.js";
import { NOTIFY_INVITES_KEY } from "../ui/alerts/alerts-invite.js";
import type { Attention } from "../ui/alerts/alerts.js";
import { createDialog } from "../ui/dialogs/dialog.js";
import { askName } from "../ui/dialogs/name-dialog.js";
import { type Notices, createNotices } from "../ui/dialogs/notices.js";
import { watchTitle } from "../ui/document-title.js";
import { createHeader } from "../ui/header/header.js";
import { syncState } from "../ui/header/sync-state.js";
import type { ObjectUrls } from "../ui/images/attached-image-sources.js";
import { createKeptField } from "../ui/menu/kept-field.js";
import { createPseudonymField } from "../ui/menu/pseudonym-field.js";
import { createSharePanel } from "../ui/menu/share-panel.js";
import { OUTLINE_KEY } from "../ui/outline/outline-column.js";
import { OUTLINE_WIDTH_KEY } from "../ui/outline/outline-width.js";
import { SIDE_BY_SIDE_KEY } from "../ui/reading/side-by-side.js";
import { attachTraceDownload } from "../ui/trace-download.js";
import { viewWidths } from "../ui/view-width.js";
import { TOOLBAR_KEY } from "../ui/writing/format-toolbar.js";
import { createWritingHelp } from "../ui/writing/writing-help.js";
import { OwnSignature } from "../view-model/own-signature.svelte.js";
import { PageMe } from "../view-model/page-me.js";
import { REMOTE_IMAGES_KEY } from "../view-model/remote-images.js";
import { watchForTraps } from "./fatal.js";
import { localStatusMessage } from "./messages.js";
import type { openDocument } from "./open-document.js";
import { SIGN_TO_NAME_KEY, followViewIdentity } from "./view-identity.js";
import { offerImageInsertion, viewAttachedImages } from "./view-images.js";
import { followLifecycle } from "./view-lifecycle.js";
import { createDocumentMenu } from "./view-menu.js";
import { followNotifications } from "./view-notifications.js";
import { followPresence } from "./view-presence.js";
import { wireReading } from "./view-reading.js";
import { followWelcome } from "./view-welcome.js";
import type { WiredClient } from "./wire-client.js";

/** What a document view takes from its host — the page, or the Obsidian
 * plugin —, and the calls whose timing a test controls
 * (`page.property.test.ts`). */
export interface DocumentViewEnvironment {
  /** Starts the view again: asked by a notice, or a change of language. */
  reload(): void;
  /** The pseudonym, the pending edit secret (R-B4), the preferences. */
  storage: Storage | undefined;
  indexedDB: IDBFactory | undefined;
  lock: DocumentLock | undefined;
  /** Where the local records go, when several sets share one IndexedDB
   * (the plugin's: one per vault). */
  localNamespace?: string;
  online(): boolean;
  /** The window: `online`/`offline`, `pagehide`, uncaught errors. */
  window: EventTarget;
  confirm(message: string): boolean;
  copy(text: string): Promise<void>;
  documentLinks: typeof documentLinks;
  openDocument: typeof openDocument;
  /** Who shows the outline: the view's own column
   * (default), or the host's (Obsidian's outline, which leads the view by
   * `MountedView.reveal`). */
  outline?: "page" | "host";
  /** The host's editor in Write (Obsidian's, in the plugin);
   * default: the page's. */
  editor?: EditorFactory;
  /** A Mac's keyboard: the shortcuts are written ⌘B, not Ctrl+B. */
  mac?: boolean;
  /** The network: the attached images (ADR-0057), and, on the page, what
   * it trusts of its gateway. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  /** `URL.createObjectURL` and its revocation: without them, or without
   * `fetch`, an attached image stays its text. */
  objectUrls?: ObjectUrls;
  /** Whether the server takes images, and its limits (ADR-0057 §6): the
   * page's `/config.json`; without it, no image is inserted. */
  attachmentLimits?: () => Promise<PageConfig["attachments"]>;
  /** The window's attention and its notifications (ADR-0060 §1); without
   * it, nothing is notified. */
  attention?: Attention;
  /** The VAPID key of the server at `apiBase`, if it posts notifications
   * (`/config.json`, W-65); without it, nobody is notified by Web Push
   * (ADR-0060 §3). */
  pushKey?: (apiBase: string) => Promise<Uint8Array | undefined>;
  /** This browser's push; without it (the plugin), this device isn't
   * offered to be notified page closed. */
  devicePush?: DevicePush;
}

/** What a view keeps in `storage` that is a preference, not a secret: a
 * host may keep these where it keeps its settings (the plugin's `data.json`),
 * and anything else nowhere but in a
 * secret store (the edit secret pending a rotation, R-B4). */
export const PREFERENCE_KEYS: readonly string[] = [
  PSEUDONYM_KEY,
  SIGN_TO_NAME_KEY,
  LANGUAGE_KEY,
  FORMATTING_KEY,
  SIDE_BY_SIDE_KEY,
  OUTLINE_KEY,
  OUTLINE_WIDTH_KEY,
  TOOLBAR_KEY,
  REMOTE_IMAGES_KEY,
  NOTIFY_INVITES_KEY,
];

/** The document a view opens, and what ties it to its host. */
export interface DocumentTarget {
  /** The server's HTTP origin; its WebSocket is derived from it. */
  apiBase: string;
  documentId: string;
  link: LinkFragment;
  /** Where the share links lead (the page's address), read when needed. */
  linkBase(): string;
  /** The edit link changed: a rotation (ADR-0019 §5). */
  onEditLink?(links: Record<Role, string>): void;
  /** Opened, or refused: the page then registers its service worker
   * (SW5). */
  onOpened?(): void;
  /** `?perf`: measures, and the work counters on the window. */
  perf?: boolean;
  /** `?trace`: a replayable trace of this view (trace/). */
  trace?: boolean;
  /** The first visit's banner (ADR-0064, AC1 – AC3): the page's; not the
   * plugin's, whatever its editor. */
  welcome?: boolean;
  /** « Mes documents »: what the view tells the keyring. */
  keyring?: DocumentKeyring;
  /** The key the view signs with (docs/protocol/06-identity.md);
   * omitted: nothing is signed. */
  identity?: IdentityKeys;
  /** What the page trusts of its gateway: read beside the
   * opening, applied once known; closed with the view. */
  trust?: Promise<Trust | undefined>;
  /** The identity and « Mes documents »: what follows a
   * sign-in here, which what is signed waits for. */
  association?: Promise<DocumentAssociation | undefined>;
  /** The name of the identity signed in on this browser, if any: the
   * first name chosen, without a question. */
  signedInName?: () => Promise<string | undefined>;
  /** The host's own « Mes documents » (the plugin's view), where the list
   * here is seen to: what would lead to the home page opens it instead.
   * Omitted (the page): the home page, in another tab. */
  openHome?(): void;
}

/** A view's frame: built in its element, never looked up in the window. */
export interface ViewFrame {
  topbar: HTMLElement;
  notices: HTMLElement;
  workspace: HTMLElement;
  /** The outline's column, left of the text; hidden until a
   * column is mounted in it. */
  outline: HTMLElement;
  editor: HTMLElement;
  annotations: HTMLElement;
}

/** An open view: `close` it when its element goes (the plugin's tab);
 * resolves once what was typed is kept and the local lock let go. */
export interface MountedView {
  close(): Promise<void>;
  /** Its text's document, once open (not when refused): the plugin
   * exports it. */
  readonly content?: LoroDoc;
  /** Publishes a change imported into `content` outside the editor, in
   * order (R-A1): only for an editor, once open. */
  readonly adopt?: (change: Uint8Array) => void;
  /** Brings a heading to the top of what is read, found in the text now
   *; false when there is none. Once open. */
  readonly reveal?: (target: HeadingTarget) => boolean;
  /** Goes where `[t](#id)` leads, a heading: for an
   * address's `h` (decision 4); false when there is none. Once open. */
  readonly anchor?: (id: string) => boolean;
  /** Gives the editor the focus (a host's tab shown). Once
   * open. */
  readonly focus?: () => void;
  /** Moves the section the caret is in: a host's
   * command; false when it can't. Only for an editor, once open. */
  readonly moveSection?: (direction: "up" | "down") => boolean;
  /** Goes to the next or the previous annotation that awaits my reply
   * (ADR-0050 §5): a host's command. Not for a reader, once open. */
  readonly stepAwaiting?: (by: -1 | 1) => void;
  /** Calls `told` at each import into `content` from the server, its text
   * changed or not (`OpenedDocument.onImport`): the plugin's export
   * waits for operations Loro says nothing of. Returns how to stop. Once
   * open. */
  readonly imported?: (told: () => void) => () => void;
  /** An attached image's bytes and format (ADR-0058 §2): the plugin
   * writes them to the vault. `undefined` if it can't be had. Once open,
   * where the view shows images. */
  readonly image?: (id: string) => Promise<OpenedImage | undefined>;
}

/** Builds the view's frame at the end of `root`. */
export function createViewFrame(root: HTMLElement): ViewFrame {
  const element = (tag: string, className: string) => {
    const created = document.createElement(tag);
    created.className = className;
    return created;
  };
  root.classList.add("document-view");
  // Its language, on its own element: a host's may differ.
  root.lang = currentLanguage();
  const frame: ViewFrame = {
    topbar: element("header", "view-topbar"),
    notices: element("div", "view-notices"),
    workspace: element("main", "view-workspace"),
    outline: element("aside", "view-outline"),
    editor: element("div", "view-editor"),
    annotations: element("aside", "view-annotations"),
  };
  frame.outline.hidden = true;
  frame.workspace.append(frame.outline, frame.editor, frame.annotations);
  root.append(frame.topbar, frame.notices, frame.workspace);
  return frame;
}

/** Notices under the header, never over the text; one that
 * asks for a reload offers it. */
export function noticeShower(
  frame: Pick<ViewFrame, "notices">,
  reload: () => void,
): (
  text: string,
  action?: boolean | { label: string; run: () => void },
) => void {
  let notices: Notices | undefined;
  return (text, action = false) => {
    notices ??= createNotices(frame.notices);
    notices.show(
      text,
      action === true
        ? { label: t().reload, run: () => reload() }
        : action || undefined,
    );
  };
}

/** Entries skipped because they don't decrypt or aren't Loro updates
 * (docs/phase-5-modele-acces.md, decision 10): a discreet count, not an
 * error — the rest of the document is there. */
function invalidEntriesCounter(parent: Element): () => void {
  let count = 0;
  let line: HTMLElement | undefined;
  return () => {
    count++;
    if (!line) {
      line = document.createElement("div");
      line.className = "invalid-entries";
      parent.append(line);
    }
    line.textContent = t().invalidEntries(count);
  };
}

/** Where the document is kept on this device (ADR-0022), and what the
 * view says of it. */
function localOptions(
  env: DocumentViewEnvironment,
  options: {
    showNotice(text: string): void;
    onUnsent(count: number): void;
    listen(target: EventTarget, type: string, listener: () => void): void;
  },
): Parameters<typeof openDocument>[0]["local"] {
  const { showNotice, listen } = options;
  return {
    ...(env.indexedDB && { indexedDB: env.indexedDB }),
    ...(env.lock && { lock: env.lock }),
    ...(env.localNamespace && { namespace: env.localNamespace }),
    onStatus: (status) => {
      const message = localStatusMessage(status);
      if (message) showNotice(message);
    },
    onUnsent: (count) => options.onUnsent(count),
    onSaveError: (error) => {
      console.warn("local save", error);
      showNotice(t().saveFailed);
    },
    flushOn: (flush) => {
      listen(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
      listen(env.window, "pagehide", flush);
    },
  };
}

/** The name this device shows (ADR-0008): asked once, in a dialog, by a
 * link that writes; a read link writes nothing that carries one. */
async function pseudonym(
  role: Role,
  storage: Storage | undefined,
  parent: Element,
  signedInName?: () => Promise<string | undefined>,
): Promise<string> {
  // Signed in on this browser: the identity's name, not a question
  //; still changed in the menu, as any name.
  const ask = async () => (await signedInName?.()) ?? askName(parent);
  if (!storage) {
    return role === "read"
      ? t().anonymous
      : (await ask())?.trim() || t().anonymous;
  }
  if (role === "read") return storedPseudonym(storage) ?? t().anonymous;
  return ensurePseudonym(ask, storage);
}

/** Opens a document in `root`: its header, dialogs, editor and
 * annotations, all inside it (docs/phase-14-plugin-obsidian.md,
 * decision 2). Resolves once it is up, or refused. */
export async function mountDocumentView(
  root: HTMLElement,
  env: DocumentViewEnvironment,
  target: DocumentTarget,
  frame: ViewFrame = createViewFrame(root),
): Promise<MountedView> {
  // What the view listens to outside its element, removed when it closes.
  const stops: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, listener: () => void) => {
    target.addEventListener(type, listener);
    stops.push(() => target.removeEventListener(type, listener));
  };
  // Its widths, not the window's.
  const widths = viewWidths(root);
  stops.push(() => widths.close());
  let closeDocument = async () => {};
  const mounted: { -readonly [K in keyof MountedView]: MountedView[K] } = {
    async close() {
      for (const stop of stops.splice(0)) stop();
      await closeDocument();
    },
  };
  const showNotice = noticeShower(frame, () => env.reload());
  const { link, documentId: docId, perf } = target;
  /** What this browser signs with, and why not under the name. */
  const own = new OwnSignature();
  /** Who « I » am, for what awaits my reply (ADR-0050 §2): my name, the
   * account signed in, my keys — each followed. */
  const me = new PageMe("");
  const followKeys = (): Promise<void> =>
    target.identity
      ?.fingerprints()
      .then((keys) => me.setKeys(keys))
      .catch(() => {}) ?? Promise.resolve();
  let viewClosed = false;
  stops.push(() => {
    viewClosed = true;
  });
  const identity = followViewIdentity({
    root,
    target,
    storage: env.storage,
    own,
    me,
    followKeys,
    stops,
    closed: () => viewClosed,
  });
  const { trusted } = identity;
  const parent = frame.editor;
  const annotationsParent = frame.annotations;
  const wsBase = target.apiBase.replace(/^http/, "ws");
  if (perf) {
    enableMarks();
    // The work counters, read from a browser's console or a test driver.
    Object.assign(env.window, { ocCounters: counters });
  }
  const key = await importKeyFromBase64Url(link.key);
  const { storage } = env;
  const { keyring } = target;
  const keyringFailed = (error: unknown) => console.warn("keyring", error);
  // Unsent changes, for the refusal message and the header: unknown
  // until this device keeps the document and has counted them.
  let unsent = 0;
  let counted = false;
  const lifecycle = followLifecycle({
    link,
    documentId: docId,
    storage,
    keyring,
    documentLinks: env.documentLinks,
    linkBase: () => target.linkBase(),
    onEditLink: (links) => target.onEditLink?.(links),
    confirm: (message) => env.confirm(message),
    showNotice,
    unsent: () => unsent,
  });

  // Read at each action: changed from the page (phase 7 decision 9).
  // Asked before the document opens, the first time only: then nothing
  // can register a name before it is known.
  let chosen = await pseudonym(link.role, storage, root, target.signedInName);
  const kept = await target.signedInName?.();
  // From the tokens kept until the sign-in is read, then from it.
  const identityName = () => {
    const account = identity.account();
    return account ? account.name : kept;
  };
  let author = authorOf(chosen, identityName()).name;
  me.setPseudonym(author);
  // Who I am known, for the alerts (NV7).
  const keysKnown = followKeys();
  void target.identity
    ?.subscribe(followKeys)
    .then((stop) => (viewClosed ? stop() : stops.push(stop)));
  // The view's frame: the header, its dialogs.
  const shareDialog = createDialog(t().share, "share-dialog", root);
  const documentDialog = createDialog(t().document, "document-dialog", root);
  const header = createHeader(frame.topbar, {
    role: link.role,
    onShare: () => shareDialog.open(),
    onDocument: () => {
      documentDialog.open();
      menu.opened();
    },
    homeHref: new URL("/", target.apiBase).href,
    ...(target.openHome && { onHome: () => target.openHome?.() }),
    onIdentity: (action) => identity.act(action),
  });
  identity.setChip((chip) => header.setIdentity(chip));
  // The writing help, for who writes: in the menu and in the
  // formatting toolbar.
  const help = createWritingHelp(root, { mac: env.mac ?? false });
  const welcome = followWelcome({
    welcome: target.welcome ?? false,
    notices: frame.notices,
    role: link.role,
    storage,
    help,
    stops,
  });
  /** Document title, as written in it. */
  let documentTitle: string | undefined;
  const signing = identity.signing(docId);
  const notifications = followNotifications({
    root,
    role: link.role,
    env,
    apiBase: target.apiBase,
    documentId: docId,
    storage,
    me,
    signing,
    roleSecret: () => lifecycle.roleSecret(),
    title: () => documentTitle,
    name: () => author,
    keysKnown,
    say: (text) => showNotice(text),
    stops,
    closed: () => viewClosed,
  });
  const menu = createDocumentMenu(documentDialog.body, {
    role: link.role,
    help,
    close: () => documentDialog.close(),
    alerts: notifications.offers,
    own,
    identity: target.identity,
    copy: (text) => env.copy(text),
    storage,
    reload: () => env.reload(),
    stops,
  });
  identity.setMenu(menu.identity);
  if (menu.alerts) notifications.show(menu.alerts);
  // A read link writes nothing: nothing to say of its changes.
  const showSync = () =>
    header.setSync(
      counted && link.role !== "read"
        ? syncState(unsent, env.online())
        : undefined,
    );
  listen(env.window, "online", showSync);
  listen(env.window, "offline", showSync);
  const connectStart = performance.now();
  // Phase 9, analysis L4: a Loro panic, wherever it surfaces, halts the view once.
  // One seen before the document is open is applied when it is.
  let trapped: unknown;
  let halt = (error: unknown) => {
    trapped ??= error;
  };
  stops.push(watchForTraps(env.window, (error) => halt(error)));
  let wired: WiredClient | undefined;
  let reading: ReturnType<typeof wireReading> | undefined;
  const fetchImages = env.fetch?.bind(env);
  const attachedImages = viewAttachedImages({
    apiBase: target.apiBase,
    documentId: docId,
    key,
    roleSecret: () => lifecycle.roleSecret(),
    fetch: fetchImages,
    objectUrls: env.objectUrls,
    indexedDB: env.indexedDB,
    localNamespace: env.localNamespace,
  });
  if (attachedImages) stops.push(() => attachedImages.close());
  const opening = env.openDocument({
    ...(attachedImages && { attachedImages }),
    url: `${wsBase}/ws`,
    documentId: docId,
    key,
    credentials: { role: link.role, secret: link.secret },
    onRefused: (code) => lifecycle.refused(code),
    ...(lifecycle.pending && { pendingEditSecret: lifecycle.pending }),
    onRenewed: (secret) => void lifecycle.renewed(secret),
    onExpiry: (at) => lifecycle.setExpiry(at),
    onInvalidEntry: invalidEntriesCounter(root),
    onFatal: (error) => {
      console.error("internal error (Loro)", error);
      if (wired) makeReadOnly(wired.editor.view);
      showNotice(t().internalError, true);
    },
    editorParent: parent,
    panelParent: annotationsParent,
    modesParent: header.modes,
    filesParent: menu.files,
    margin: {
      workspace: frame.workspace,
      keys: root,
      narrow: widths.narrow,
      wide: widths.wide,
      readingTop: () => frame.topbar.getBoundingClientRect().height,
    },
    author: () => author,
    ownSignature: own,
    me,
    // What may notify (ADR-0060 §5), and what invites to be notified
    //.
    onWritten: (written) => notifications.written(written),
    ...(signing && { signing }),
    // Formatted unless this device chose the source.
    livePreview: storedFormatting(storage),
    ...(env.editor && { editor: env.editor }),
    preferences: storage,
    mac: env.mac ?? false,
    onHelp: () => help.open(),
    local: localOptions(env, {
      showNotice,
      onUnsent: (count) => {
        unsent = count;
        counted = true;
        showSync();
      },
      listen,
    }),
    trace: target.trace ?? false,
    onWired: (client) => {
      wired = client;
      trusted(client.signatures);
      watchTitle(client.editor.view, (title) => {
        documentTitle = title;
        header.setTitle(title);
        if (title) void keyring?.title(title).catch(keyringFailed);
      });
      welcome.wired(client);
      reading = wireReading(client, {
        frame,
        widths,
        outline: env.outline,
        preferences: storage,
        apiBase: target.apiBase,
        keyring,
        showNotice,
        stops,
      });
      if (!client.recorder) return;
      client.recorder.captureGlobals(window);
      attachTraceDownload(annotationsParent, client.recorder, author);
    },
  });
  let opened: Awaited<typeof opening>;
  try {
    opened = await opening;
  } catch (error) {
    if (!(error instanceof ConnectionRefused)) throw error;
    lifecycle.refused(error.code);
    target.onOpened?.();
    return mounted;
  }
  target.onOpened?.();
  void keyring?.opened(lifecycle.currentLink()).catch(keyringFailed);
  halt = opened.halt;
  mounted.content = opened.contentDoc;
  mounted.imported = (told) =>
    opened.onImport((channel) => {
      if (channel === "content") told();
    });
  if (attachedImages) mounted.image = (id) => attachedImages.opened(id);
  if (reading) {
    mounted.reveal = reading.reveal;
    mounted.anchor = reading.anchor;
  }
  mounted.focus = () => opened.client.editor.view.focus();
  notifications.opened(opened);
  const { stepAwaiting } = opened.client;
  if (stepAwaiting) mounted.stepAwaiting = stepAwaiting;
  reading?.column?.opened();
  if (
    link.role === "edit" &&
    attachedImages &&
    fetchImages &&
    env.attachmentLimits
  ) {
    offerImageInsertion({
      limits: env.attachmentLimits(),
      view: opened.client.editor.view,
      parent,
      root,
      apiBase: target.apiBase,
      documentId: docId,
      key,
      roleSecret: () => lifecycle.roleSecret(),
      fetch: fetchImages,
      attached: attachedImages,
      notify: (message) => showNotice(message),
      stops,
      closed: () => viewClosed,
    });
  }
  if (mayPublish(link.role, "content")) {
    mounted.adopt = (change) => opened.connection.adopt("content", change);
    mounted.moveSection = (direction) =>
      moveSectionBy(opened.client.editor.view, direction);
  }
  closeDocument = async () => {
    // Nothing typed after this: the last save holds all of it.
    opened.client.editor.destroy();
    await opened.close();
  };
  if (trapped !== undefined) opened.halt(trapped);
  const { connection } = opened;
  const shownSecret = lifecycle.editSecret();
  const sharePanel = createSharePanel(shareDialog.body, {
    role: link.role,
    links: shownSecret ? await lifecycle.linksOf(shownSecret) : undefined,
    onRenew: () => lifecycle.renew(connection),
    confirm: (message) => env.confirm(message),
    copy: (text) => env.copy(text),
  });
  const renewedMeanwhile = lifecycle.setSharePanel(sharePanel);
  if (renewedMeanwhile) {
    const links = await lifecycle.linksOf(renewedMeanwhile);
    if (renewedMeanwhile === lifecycle.editSecret()) {
      sharePanel.setLinks(links, true);
    }
  }
  // Only where this device has « Mes documents ».
  void keyring?.available().then((available) => {
    if (!available) return;
    createKeptField(menu.kept, {
      isKept: () => keyring.isKept(),
      setKept: (kept) => keyring.setKept(kept, lifecycle.currentLink()),
    });
  });
  const nameField = createPseudonymField(menu.name, {
    name: author,
    save: (name) => (storage ? savePseudonym(name, storage) : undefined),
    onRenamed: (name) => {
      chosen = name;
      followAuthor();
    },
  });
  const followAuthor = () => {
    const next = authorOf(chosen, identityName());
    nameField.show(next.name, next.fromIdentity);
    if (next.name === author) return;
    author = next.name;
    me.setPseudonym(author);
    opened.registration.renamed();
    opened.presence.renamed();
  };
  identity.setFollowAuthor(followAuthor);
  followAuthor();
  followPresence(opened, {
    documentId: docId,
    parent: header.presence,
    trusted,
    stops,
  });
  // Gone at once for the others (R-P5), rather than in 30 s.
  listen(env.window, "pagehide", () => opened.presence.leave());
  lifecycle.opened({
    expiry: menu.expiry,
    danger: menu.danger,
    connection,
    readOnly: () => makeReadOnly(opened.client.editor.view),
  });
  // An empty document that this link writes: the caret is where to type.
  const { view } = opened.client.editor;
  if (link.role === "edit" && view.state.doc.length === 0) view.focus();
  if (perf) {
    // Let the effects scheduled by the history replies run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    reportOpening(connectStart, opened.client.signatures);
  }
  return mounted;
}

/** `?perf`: from connecting to a settled view (history, its import,
 * rendering), and from navigation start (0), page load included; then
 * the signatures, verified after the view
 * settled, which doesn't wait for them. */
function reportOpening(
  connectStart: number,
  signatures: { idle(): Promise<void> },
): void {
  const connectMs = measureSince("connect", connectStart);
  const openMs = measureSince("open", 0);
  console.info(
    `[perf] connect→settled: ${connectMs.toFixed(0)} ms, navigation→settled: ${openMs.toFixed(0)} ms`,
  );
  console.table(timings());
  console.table(counters());
  void signatures.idle().then(() => {
    const verifiedMs = measureSince("signatures", connectStart);
    console.info(
      `[perf] connect→signatures verified: ${verifiedMs.toFixed(0)} ms, ${counters()["identity.verify"] ?? 0} verified`,
    );
  });
}
