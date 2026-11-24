import {
  FileView,
  Scope,
  type TFile,
  type WorkspaceLeaf,
  normalizePath,
  resolveSubpath,
} from "obsidian";
import { documentLinks } from "../../web/lib/src/index.js";
import {
  type DocumentLock,
  type DocumentTarget,
  type DocumentViewEnvironment,
  type EditorFactory,
  type MountedView,
  documentTitle,
  mountDocumentView,
  readPageConfig,
  t,
} from "../../web/src/embed.js";
import type { NoteExporter, Outside } from "./exporter.js";
import { letFieldsTakeModEnter } from "./field-keys.js";
import {
  type EphemeralRequest,
  ephemeralRequest,
  targetFor,
} from "./heading-target.js";
import type { ImageWriter } from "./image-writer.js";
import { leafAttention } from "./leaf-attention.js";
import type { LinkStore } from "./link-store.js";
import type { LiveViews } from "./live-views.js";
import { followTitle, startExport } from "./note-export.js";
import { readLooseHeader } from "./note-header.js";
import type { VaultNotes } from "./notes.js";
import { resumeChange, resumePeer } from "./resume.js";
import {
  foundFormat,
  imageFile,
  imageFolder,
  notedImages,
  toDocument,
  toNote,
} from "./vault-images.js";
import {
  type Rename,
  type Resolve,
  applyEdits,
  isRenameRewrite,
  toAddresses,
  toWikilinks,
} from "./wikilinks.js";

/** The type of the plugin's view, in Obsidian's workspace. */
export const DOCUMENT_VIEW = "collab-link-document";

/** What the view needs of the plugin, by part. */
export interface ViewHost {
  links: LinkStore;
  /** The view's environment, but for `reload`. */
  environment(): Omit<DocumentViewEnvironment, "reload">;
  /** What a view of a document is given of « Mes documents » and of the
   * identity (M7). */
  documentIdentity(
    documentId: string,
    apiBase: string,
  ): Promise<Partial<DocumentTarget>>;
  /** The language may have changed: set it again before a reload. */
  applyLanguage(): void;
  /** Where a view of `note` writes: Obsidian's editor; none, the page's
   * (as chosen in the settings); "unavailable", the page's, Obsidian
   * having changed. */
  editorFor(
    note: () => TFile | null,
  ): EditorFactory | "unavailable" | undefined;
  exportDelayMs(): number;
  /** The timers (a test's, counted); returns how to cancel. */
  setTimer(run: () => void, ms: number): () => void;
  /** One live view per document (LV1–LV4). */
  views: Pick<LiveViews<DocumentLeafView>, "claim" | "live" | "release">;
  /** Obsidian's workspace, as the view's tab sees it. */
  workspace: {
    /** Shows a leaf (the document's live view). */
    reveal(leaf: WorkspaceLeaf): void;
    /** `leaf` is the workspace's active one (ADR-0060 §1). */
    isActive(leaf: WorkspaceLeaf): boolean;
    /** Told when the active leaf changes; gives its removal. */
    onActiveLeafChange(listener: () => void): () => void;
  };
  /** The vault's notes: a note just created by "Open a link" follows its title
   * for its first view only; a change from outside kept beside its note. */
  notes: Pick<VaultNotes, "takeFresh" | "nameAfter" | "keepCopy">;
  /** The links between notes (ADR-0045). */
  vaultLinks: {
    /** The notes renamed lately, for their links' rewrite (LK5). */
    renames(): readonly Rename[];
    /** How `note`'s `[[…]]` resolve; none without the link store. */
    resolverFor(note: TFile): Resolve | undefined;
    /** How a document is named from `note`, at unlinking. */
    namesFor(note: TFile): (documentId: string) => string | undefined;
    /** `note` unlinked from `documentId`: remembered. */
    noteUnlinked(documentId: string, note: TFile): void;
  };
  /** The attached images in the vault (ADR-0058 §2). */
  images: {
    /** The setting: attached images written to the vault. */
    inVault(): boolean;
    /** The plugin's folder, where `images/` is. */
    folder(): string;
  };
}

/** One showing of a note by the view, from `onLoadFile` until the view
 * shows another note or closes. */
interface Opening {
  file: TFile;
  /** The view moved on: what it opens is closed at once, and said
   * nowhere. */
  passed: boolean;
  /** The document it holds (`claim`) while it opens. */
  claimed: string | undefined;
  /** Its closing, once asked. */
  closing: Promise<void> | undefined;
  /** Resolves once it has ended — shown, or closed —: a document it held
   * still opening is then free (its lock too). */
  ended: Promise<void>;
  end(): void;
}

function openingOf(file: TFile): Opening {
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    file,
    passed: false,
    claimed: undefined,
    closing: undefined,
    ended,
    end,
  };
}

interface Shown {
  documentId: string;
  mounted: MountedView;
  exporter: NoteExporter<TFile> | undefined;
  images: ImageWriter | undefined;
  stopTitle: (() => void) | undefined;
}

/** A linked note, shown in the page's view (docs/phase-14-plugin-obsidian.md,
 * decisions 1, 2, 3): the view mounted in the tab, its document exported
 * to the note's file. The tab's state is the note's path, as Obsidian's
 * own editor's: never a key nor a secret. */
export class DocumentLeafView extends FileView {
  private shown: Promise<Shown | undefined> = Promise.resolve(undefined);
  /** What is shown, once open. */
  private current: Shown | undefined;
  /** The note shown last, its document perhaps still opening. */
  private opening: Opening | undefined;
  /** Those still running, one the view moved on from included. */
  private readonly openings = new Set<Opening>();
  /** What Obsidian asked as it showed the note — a heading, the focus —, until
   * the document is open. */
  private asked: EphemeralRequest | undefined;
  /** The document this view was refused, another view holding it. */
  private refused: string | undefined;
  /** Mod+Enter left to the page's fields, until the view closes. */
  private readonly stopFieldKeys: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ViewHost,
  ) {
    super(leaf);
    // What its styles are under.
    this.contentEl.classList.add("collab-link-view");
    this.stopFieldKeys = letFieldsTakeModEnter(
      this.contentEl,
      this.app.keymap,
      new Scope(this.app.scope),
    );
  }

  getViewType(): string {
    return DOCUMENT_VIEW;
  }

  override getIcon(): string {
    return "users";
  }

  /** Resolves once the note is shown: its document mounted, refused, or a
   * message; not while it waits for a name or the server. */
  async ready(): Promise<void> {
    await this.shown;
  }

  /** Resolves once no opening of the view runs, one it moved on from
   * included: nothing left out of a test's hands (AGENTS.md §1.6). */
  async idle(): Promise<void> {
    await Promise.all([...this.openings].map(({ ended }) => ended));
  }

  override async onLoadFile(file: TFile): Promise<void> {
    // Asked of another note: not of this one.
    this.asked = undefined;
    this.showNote(file);
  }

  private showNote(file: TFile): void {
    const opening = openingOf(file);
    this.opening = opening;
    this.openings.add(opening);
    // Not awaited: opening may wait for a name, or for a server that
    // doesn't answer; Obsidian waits for `onLoadFile`.
    this.shown = this.show(opening).finally(() => {
      this.openings.delete(opening);
      opening.end();
    });
  }

  override async onUnloadFile(): Promise<void> {
    this.asked = undefined;
    await this.closeShown();
  }

  protected override async onClose(): Promise<void> {
    this.stopFieldKeys();
    this.asked = undefined;
    await this.closeShown();
  }

  /** Obsidian shows the note: at a heading (its outline: a line of the file; a
   * link: a subpath), or just focused. Answered once the document is open; the
   * last heading asked wins. A view refused its document hands a heading to the
   * one that holds it, and shows it; the focus alone, it keeps. */
  override setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const asked = ephemeralRequest(state);
    if (!asked) return;
    const heading = asked.line !== undefined || asked.subpath !== undefined;
    if (this.refused !== undefined) {
      if (heading) this.handOver(this.refused, asked);
      return;
    }
    const before = this.asked;
    this.asked = heading
      ? { ...asked, focus: asked.focus || (before?.focus ?? false) }
      : { ...(before ?? asked), focus: true };
    this.answer();
  }

  /** Gives `asked` to the view that holds `documentId`, and shows it. */
  private handOver(documentId: string, asked: EphemeralRequest): void {
    const live = this.host.views.live(documentId);
    if (!live || live === this) return;
    this.host.workspace.reveal(live.leaf);
    live.setEphemeralState({
      ...(asked.line !== undefined && { line: asked.line }),
      ...(asked.subpath !== undefined && { subpath: asked.subpath }),
      focus: true,
    });
  }

  /** Answers what was asked, if the document is open — its history
   * received (`mountDocumentView` resolves after it): a heading is found
   * in Obsidian's metadataCache of the note (the export), then in the
   * text now. */
  private answer(): void {
    const asked = this.asked;
    const shown = this.current;
    const file = this.file;
    if (!asked || !shown || !file) return;
    this.asked = undefined;
    const { mounted } = shown;
    if (asked.line !== undefined || asked.subpath !== undefined) {
      const cache = this.app.metadataCache.getFileCache(file);
      const target = targetFor(cache?.headings, asked, (subpath) => {
        const found = cache ? resolveSubpath(cache, subpath) : null;
        return found?.type === "heading" ? found.current : undefined;
      });
      if (target && mounted.reveal?.(target)) return;
    }
    if (asked.focus) mounted.focus?.();
  }

  /** Moves the section the caret is in; undefined when the view can't (not
   * open, or not an editor's). */
  canMoveSection(): boolean {
    return this.current?.mounted.moveSection !== undefined;
  }

  moveSection(direction: "up" | "down"): boolean | undefined {
    const move = this.current?.mounted.moveSection;
    return move ? move(direction) : undefined;
  }

  /** Goes to the next or the previous annotation that awaits my reply
   * (ADR-0050 §5); false when the view can't (not open, a reader's). */
  stepAwaiting(by: -1 | 1, checking: boolean): boolean {
    const step = this.current?.mounted.stepAwaiting;
    if (step && !checking) step(by);
    return step !== undefined;
  }

  /** The setting of the images changed (ADR-0058 §2): exported again. */
  imagesChanged(): void {
    this.current?.exporter?.changed();
  }

  /** Obsidian says the note's file changed: unless it is the export's own
   * write, it is looked at. */
  async fileChanged(): Promise<void> {
    const { file, current } = this;
    if (!file || !current?.exporter) return;
    current.exporter.noticed(await this.app.vault.read(file));
  }

  /** "Unlink this note": the last export written, the header taken off,
   * the link forgotten; the document stays on the server. */
  async unlink(): Promise<void> {
    const file = this.file;
    const shown = await this.shown;
    if (!file || !shown) return;
    // Its addresses of notes of this vault, their names again: of its server,
    // the link's, read before it is forgotten.
    const apiBase = this.host.links.get(shown.documentId)?.apiBase;
    const nameOf = this.host.vaultLinks.namesFor(file);
    await this.closeShown();
    await this.app.vault.process(file, (current) => {
      const { content, document } = readLooseHeader(current);
      if (document !== shown.documentId) return current;
      return apiBase
        ? applyEdits(content, toWikilinks(content, apiBase, nameOf))
        : content;
    });
    this.host.links.forget(shown.documentId);
    this.host.vaultLinks.noteUnlinked(shown.documentId, file);
    await this.leaf.setViewState({
      type: "markdown",
      state: { file: file.path },
    });
  }

  /** The note's `[[…]]` to linked notes, written as their addresses in its
   * document, by this device (the command; a note just shared). How many; none
   * for a view not open, or not an editor's. */
  convertLinks(): number | undefined {
    const file = this.file;
    const mounted = this.current?.mounted;
    if (!file || !mounted?.content || !mounted.adopt) return undefined;
    const resolve = this.host.vaultLinks.resolverFor(file);
    if (!resolve) return 0;
    const text = mounted.content.getText("content");
    const before = text.toString();
    const edits = toAddresses(before, resolve);
    if (edits.length === 0) return 0;
    // A local change of the document: published, and brought into the
    // editor by its binding (LK2: never the file).
    text.update(applyEdits(before, edits));
    mounted.content.commit();
    return edits.length;
  }

  /** `outside`'s text replayed on its base, as « Reprendre » does (ME3);
   * for an editor's view only. */
  private async resume(
    outside: Outside,
    documentId: string,
    mounted: MountedView,
  ): Promise<void> {
    const { content, adopt } = mounted;
    const base = outside.base;
    if (!content || !adopt || !base) return;
    const peer = await resumePeer(documentId, base, outside.text);
    const change = resumeChange(content, base, outside.text, peer);
    content.import(change);
    adopt(change);
  }

  private say(text: string): HTMLElement {
    const line = this.contentEl.ownerDocument.createElement("p");
    line.className = "collab-link-message";
    line.textContent = text;
    this.contentEl.append(line);
    return line;
  }

  /** Says where a change from outside is kept; to an editor, with a base,
   * offers to resume it, once. */
  private outside(
    outside: Outside,
    documentId: string,
    mounted: MountedView,
  ): void {
    const line = this.say(t().pluginModifiedOutside(outside.copy));
    const { content, adopt } = mounted;
    const { base } = outside;
    if (!content || !adopt || !base) return;
    const button = this.contentEl.ownerDocument.createElement("button");
    button.className = "collab-link-resume";
    button.textContent = t().pluginResume;
    button.addEventListener("click", async () => {
      button.remove();
      try {
        await this.resume(outside, documentId, mounted);
        line.textContent = t().pluginResumed;
      } catch (error) {
        line.textContent = t().pluginResumeFailed(
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    line.after(button);
  }

  /** `documentId` held by another view: said, with a way to it; a heading asked
   * meanwhile goes to that view. */
  private refusedBy(documentId: string): void {
    this.say(t().pluginOpenElsewhere);
    const go = this.contentEl.ownerDocument.createElement("button");
    go.className = "collab-link-go";
    go.textContent = t().pluginGoToTab;
    go.addEventListener("click", () => {
      const live = this.host.views.live(documentId);
      if (live) this.host.workspace.reveal(live.leaf);
    });
    this.contentEl.append(go);
    this.refused = documentId;
    const asked = this.asked;
    this.asked = undefined;
    if (asked && (asked.line !== undefined || asked.subpath !== undefined)) {
      this.handOver(documentId, asked);
    }
  }

  /** Opens `opening`'s note. Each `await` may find the view gone to
   * another note, or closed: then nothing more is said or written, what
   * opened is closed, and the document let go (a user's report: the view
   * moved on, offline, while its first document opened; that document
   * held, refused to another tab, then shown and exported in the second
   * note once online). */
  private async show(opening: Opening): Promise<Shown | undefined> {
    const { file } = opening;
    // The note, while this view shows it: never another (above).
    const note = () => (this.file === file ? file : null);
    this.contentEl.replaceChildren();
    this.refused = undefined;
    // However another tool rewrote its header.
    const { document: documentId } = readLooseHeader(
      await this.app.vault.cachedRead(file),
    );
    if (opening.passed) return undefined;
    if (documentId === undefined) {
      this.say(t().pluginNotLinked);
      return undefined;
    }
    const link = this.host.links.get(documentId);
    if (!link) {
      this.say(t().pluginLinkNeeded);
      return undefined;
    }
    opening.claimed = documentId;
    const claimed = await this.host.views.claim(documentId, this);
    if (!claimed) opening.claimed = undefined;
    // Let go, if claimed, by `closeShown`.
    if (opening.passed) return undefined;
    if (!claimed) {
      this.refusedBy(documentId);
      return undefined;
    }
    const editor = this.host.editorFor(note);
    if (editor === "unavailable") this.say(t().pluginEditorUnavailable);
    const root = this.contentEl.ownerDocument.createElement("div");
    this.contentEl.append(root);
    const leaf = this.leaf;
    const environment: DocumentViewEnvironment = {
      ...this.host.environment(),
      ...(editor && editor !== "unavailable" && { editor }),
      // Looked at: Obsidian focused, this leaf active (ADR-0060 §1).
      attention: leafAttention({
        window: root.ownerDocument.defaultView ?? window,
        document: root.ownerDocument,
        ...(typeof Notification === "function" && { Notification }),
        active: () => this.host.workspace.isActive(leaf),
        onActiveChange: (listener) =>
          this.host.workspace.onActiveLeafChange(listener),
        reveal: () => this.host.workspace.reveal(leaf),
      }),
      reload: () => {
        this.host.applyLanguage();
        void this.closeShown().then(() => {
          if (this.opening === opening) this.showNote(file);
        });
      },
    };
    let mounted: MountedView;
    try {
      const identity = await this.host.documentIdentity(
        documentId,
        link.apiBase,
      );
      if (opening.passed) return undefined;
      mounted = await mountDocumentView(root, environment, {
        ...identity,
        apiBase: link.apiBase,
        documentId,
        link: link.fragment,
        linkBase: () => `${link.apiBase}/`,
        // A rotation: the new edit link replaces the kept one.
        onEditLink: (links) => this.host.links.set(documentId, links.edit),
      });
    } catch (error) {
      if (opening.passed) return undefined;
      this.host.views.release(documentId, this, Promise.resolve());
      this.say(
        t().pluginOpenFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
      return undefined;
    }
    if (opening.passed) {
      await mounted.close();
      return undefined;
    }
    // From here to the end, nothing awaited: shown in this note.
    const shown: Shown = {
      documentId,
      mounted,
      exporter: undefined,
      images: undefined,
      stopTitle: undefined,
    };
    const { content } = mounted;
    if (content) {
      const started = startExport({
        vault: this.app.vault,
        host: this.host,
        documentId,
        mounted,
        content,
        note,
        onOutside: (outside) => this.outside(outside, documentId, mounted),
        onRecognized: (outside) =>
          void this.resume(outside, documentId, mounted).catch((error) =>
            console.warn("collab-link: a rename's rewrite not resumed", error),
          ),
      });
      shown.exporter = started.exporter;
      shown.images = started.images;
      if (this.host.notes.takeFresh(file)) {
        shown.stopTitle = followTitle({ host: this.host, file, note, content });
      }
    }
    this.current = shown;
    this.answer();
    return shown;
  }

  /** Closes what is shown, once: the last export, then the view (its last
   * save, its lock), then the document is free for another view. */
  private closeShown(): Promise<void> {
    const opening = this.opening;
    if (!opening) return Promise.resolve();
    opening.closing ??= (async () => {
      opening.passed = true;
      const shown = this.current;
      this.current = undefined;
      if (shown) await this.closeOpened(shown);
      else if (opening.claimed !== undefined) {
        // Still opening (a name, a mute server): not waited for, the view
        // moves on; `show` closes it once open, and the document is free
        // for another view then.
        this.host.views.release(opening.claimed, this, opening.ended);
      }
    })();
    return opening.closing;
  }

  private async closeOpened(shown: Shown): Promise<void> {
    const closed = (async () => {
      shown.stopTitle?.();
      await shown.images?.stop();
      await shown.exporter?.close();
      await shown.mounted.close();
    })();
    this.host.views.release(shown.documentId, this, closed);
    await closed;
  }
}

/** The view's environment in Obsidian: Obsidian's IndexedDB, one set of records
 * per vault, and its Web Locks. */
export function obsidianEnvironment(options: {
  storage: Storage;
  open: DocumentViewEnvironment["openDocument"];
  vault: string;
  indexedDB: IDBFactory | undefined;
  lock: DocumentLock | undefined;
  /** The server's HTTP, by Obsidian's `requestUrl` (no CORS stops it):
   * the attached images (ADR-0057 §8). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): Omit<DocumentViewEnvironment, "reload"> {
  return {
    storage: options.storage,
    indexedDB: options.indexedDB,
    lock: options.lock,
    localNamespace: options.vault,
    online: () => navigator.onLine,
    window,
    confirm: (message) => window.confirm(message),
    copy: (text) => navigator.clipboard.writeText(text),
    documentLinks,
    openDocument: options.open,
    // Obsidian's own outline leads the view.
    outline: "host",
    ...(options.fetch && {
      fetch: options.fetch,
      objectUrls: {
        create: (blob: Blob) => URL.createObjectURL(blob),
        revoke: (url: string) => URL.revokeObjectURL(url),
      },
      // Never the server's /config.json (OB3): the default limits; the
      // server refuses beyond (413), which the view says.
      attachmentLimits: async () => ({
        imageBytes: 10 * 1024 * 1024,
        documentBytes: 200 * 1024 * 1024,
      }),
      // The server's VAPID key (ADR-0060 §5): a reply written here notifies
      // its recipients. Nothing trusted by it: a wrong key only skips their
      // subscriptions. No device here: Electron has no push service.
      pushKey: (apiBase: string) =>
        readPageConfig(
          apiBase,
          options.fetch as NonNullable<typeof options.fetch>,
        ).then((config) => config.push?.vapidKey),
    }),
  };
}
