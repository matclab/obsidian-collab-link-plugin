// A stand-in for the `obsidian` module, which exists only inside Obsidian
// (docs/phase-14-plugin-obsidian.md, decision 10): just what the plugin
// uses, behaving as Obsidian 1.13 does where the tests depend on it — a
// leaf's view created by its type, `onOpen` before `setState`, `onClose`
// when the leaf goes; a `FileView` loads its file from the state's path,
// follows a rename, and its leaf closes when the file is deleted;
// `vault.process` reads and writes in one operation. Its own helpers
// (`FakeApp`, `notices`) are for the tests; the plugin's code sees only
// the real API's types.
import { history } from "@codemirror/commands";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fakeSecrets } from "./secrets.js";

type ViewCreator = (leaf: WorkspaceLeaf) => View;
type Listener = (...args: unknown[]) => unknown;

/** The notices shown, newest last. */
export const notices: string[] = [];

let language = "en";
/** Obsidian's interface language, as `getLanguage` returns it. */
export function setFakeLanguage(next: string): void {
  language = next;
}
export function getLanguage(): string {
  return language;
}

/** Obsidian's: one `/` between parts, none at either end; `/` for none. */
export function normalizePath(path: string): string {
  const parts = path
    .replace(/\\/g, "/")
    .replace(/\u00a0/g, " ")
    .split("/")
    .filter((part) => part !== "");
  return parts.length === 0 ? "/" : parts.join("/");
}

/** No network in the tests: the plugin's `request` is replaced. */
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl: no network in tests");
}

/** The notices given a fragment (a button in them), newest last. */
export const noticeFragments: DocumentFragment[] = [];

export class Notice {
  constructor(message: string | DocumentFragment) {
    notices.push(
      typeof message === "string" ? message : (message.textContent ?? ""),
    );
    if (typeof message !== "string") noticeFragments.push(message);
  }
}

class Events {
  private readonly listeners = new Map<string, Set<Listener>>();
  on(name: string, listener: Listener, _ctx?: unknown): { off: () => void } {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return { off: () => set.delete(listener) };
  }
  offref(ref: { off: () => void }): void {
    ref.off();
  }
  async trigger(name: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners.get(name) ?? []) {
      await listener(...args);
    }
  }
}

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
  /** Its folder; the vault's root is `/`. */
  get parent(): TFolder {
    const at = this.path.lastIndexOf("/");
    return new TFolder(at < 0 ? "/" : this.path.slice(0, at));
  }
}
export class TFolder extends TAbstractFile {}
export class TFile extends TAbstractFile {
  get extension(): string {
    return this.name.split(".").pop() ?? "";
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
}

export class Vault extends Events {
  readonly files = new Map<string, { file: TFile; text: string }>();
  readonly folders = new Set<string>();
  /** The binary files' bytes, by path (their entry in `files` is empty). */
  readonly binaries = new Map<string, Uint8Array>();
  /** Ends each `process` when the test says, if set. */
  hold: ((done: () => void) => void) | undefined;

  getName(): string {
    return "vault";
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.folders.has(path)) return new TFolder(path);
    return this.files.get(path)?.file ?? null;
  }
  getMarkdownFiles(): TFile[] {
    return [...this.files.values()]
      .map(({ file }) => file)
      .filter((file) => file.extension === "md");
  }
  async createFolder(path: string): Promise<TFolder> {
    this.folders.add(path);
    return new TFolder(path);
  }
  async create(path: string, data: string, _options?: unknown): Promise<TFile> {
    if (this.files.has(path)) throw new Error("File already exists.");
    const file = new TFile(path);
    this.files.set(path, { file, text: data });
    // As Obsidian: told once the file is there.
    await this.trigger("create", file);
    return file;
  }
  async createBinary(
    path: string,
    data: ArrayBuffer,
    _options?: unknown,
  ): Promise<TFile> {
    const file = await this.create(path, "");
    this.binaries.set(path, new Uint8Array(data));
    return file;
  }
  async read(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no file ${file.path}`);
    return entry.text;
  }
  cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  async modify(file: TFile, data: string, _options?: unknown): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no file ${file.path}`);
    entry.text = data;
    await this.trigger("modify", file);
  }
  async process(
    file: TFile,
    fn: (data: string) => string,
    _options?: unknown,
  ): Promise<string> {
    if (this.hold) await new Promise<void>((done) => this.hold?.(done));
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no file ${file.path}`);
    const next = fn(entry.text);
    if (next !== entry.text) {
      entry.text = next;
      await this.trigger("modify", file);
    }
    return next;
  }
  async delete(file: TFile, _force?: boolean): Promise<void> {
    this.files.delete(file.path);
    await this.trigger("delete", file);
  }
  /** The text of the file at `path` (tests). */
  text(path: string): string | undefined {
    return this.files.get(path)?.text;
  }
}

/** A heading of `metadataCache`, as far as the tests need it. */
export interface HeadingCache {
  heading: string;
  level: number;
  position: {
    start: { line: number; col: number; offset: number };
    end: { line: number; col: number; offset: number };
  };
}

/** Obsidian's metadataCache, its headings only: the ATX ones of the
 * file's text, past its YAML header — enough for the tests' notes. */
export class MetadataCache {
  constructor(private readonly vault: Vault) {}
  /** A `[[…]]`'s note from `source`: by path, else by name (the
   * shortest form, as Obsidian writes them). */
  getFirstLinkpathDest(linkpath: string, _source: string): TFile | null {
    const files = this.vault.getMarkdownFiles();
    const path = linkpath.endsWith(".md") ? linkpath : `${linkpath}.md`;
    return (
      files.find((file) => file.path === path) ??
      files.find((file) => file.name === path) ??
      null
    );
  }
  /** The shortest link text: the name, unless two notes share it. */
  fileToLinktext(file: TFile, _source: string, omitMdExtension = true): string {
    const same = this.vault
      .getMarkdownFiles()
      .filter((other) => other.name === file.name);
    const text = same.length > 1 ? file.path : file.name;
    return omitMdExtension ? text.replace(/\.md$/, "") : text;
  }
  getFileCache(file: TFile): {
    headings?: HeadingCache[];
    frontmatter?: Record<string, unknown>;
  } | null {
    const text = this.vault.text(file.path);
    if (text === undefined) return null;
    const lines = text.split("\n");
    let at = 0;
    let frontmatter: Record<string, unknown> | undefined;
    if (lines[0] === "---") {
      at = lines.indexOf("---", 1) + 1;
      if (at === 0) return {};
      // `key: "value"` lines: enough for the plugin's own header.
      frontmatter = {};
      for (const line of lines.slice(1, at - 1)) {
        const match = /^([\w-]+):\s*"?([^"]*)"?$/.exec(line);
        if (match) frontmatter[match[1] as string] = match[2];
      }
    }
    const headings: HeadingCache[] = [];
    for (let line = at; line < lines.length; line++) {
      const match = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(
        lines[line] ?? "",
      );
      if (!match) continue;
      const position = { line, col: 0, offset: 0 };
      headings.push({
        heading: match[2] ?? "",
        level: match[1]?.length ?? 1,
        position: { start: position, end: position },
      });
    }
    return {
      ...(headings.length > 0 && { headings }),
      ...(frontmatter && { frontmatter }),
    };
  }
}

/** Obsidian's `resolveSubpath`, for headings: each part of `#A#B` found
 * after the one before it. */
export function resolveSubpath(
  cache: { headings?: HeadingCache[] },
  subpath: string,
): { type: "heading"; current: HeadingCache } | null {
  const parts = subpath.split("#").filter((part) => part !== "");
  let from = 0;
  let current: HeadingCache | undefined;
  for (const part of parts) {
    const headings = cache.headings ?? [];
    const at = headings.findIndex((h, i) => i >= from && h.heading === part);
    if (at < 0) return null;
    current = headings[at];
    from = at + 1;
  }
  return current ? { type: "heading", current } : null;
}

export class FileManager {
  constructor(private readonly app: FakeApp) {}
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const { vault } = this.app;
    const entry = vault.files.get(file.path);
    if (!entry) throw new Error(`no file ${file.path}`);
    if (vault.files.has(newPath)) throw new Error("Destination exists.");
    const oldPath = file.path;
    vault.files.delete(oldPath);
    file.path = newPath;
    vault.files.set(newPath, entry);
    for (const leaf of this.app.workspace.leaves) {
      const view = leaf.view;
      if (view instanceof FileView && view.file === file) {
        await view.onRename(entry.file);
      }
    }
    await vault.trigger("rename", file, oldPath);
  }
}

export class Workspace extends Events {
  readonly leaves: WorkspaceLeaf[] = [];
  readonly creators = new Map<string, ViewCreator>();
  activeLeaf: WorkspaceLeaf | null = null;
  /** What Obsidian's editing commands act on (not a Markdown tab's, in
   * this fake). */
  activeEditor: unknown = null;
  /** How many times Obsidian told its editors to read their options. */
  optionsUpdated = 0;
  unsetActiveEditor(editor?: unknown): void {
    if (!editor || this.activeEditor === editor) this.activeEditor = null;
  }
  updateOptions(): void {
    this.optionsUpdated++;
  }
  constructor(readonly app: FakeApp) {
    super();
  }

  /** The layout is ready in this fake from the start. */
  onLayoutReady(run: () => void): void {
    run();
  }

  getLeaf(newLeaf?: unknown, direction?: unknown): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app);
    // How it was asked: a tab, a split beside (and which way)…
    leaf.openedAs = [newLeaf, direction].filter(Boolean).join(" ");
    this.leaves.push(leaf);
    this.activeLeaf = leaf;
    return leaf;
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((leaf) => leaf.view?.getViewType() === type);
  }
  getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
    const view = this.activeLeaf?.view;
    return view instanceof type ? (view as T) : null;
  }
  getActiveFile(): TFile | null {
    const view = this.activeLeaf?.view;
    return view instanceof FileView ? view.file : null;
  }
  /** The focus asked (`{ focus: true }`) has no effect in this fake. */
  setActiveLeaf(
    leaf: WorkspaceLeaf,
    _params?: unknown,
    _focus?: boolean,
  ): void {
    this.activeLeaf = leaf;
    this.activeEditor = null;
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.activeLeaf = leaf;
  }
}

/** A component's life, as Obsidian's `Component`. */
export class Component {
  private readonly children: Component[] = [];
  loaded = false;
  load(): void {
    this.loaded = true;
    this.onload();
  }
  unload(): void {
    for (const child of this.children.splice(0)) child.unload();
    this.loaded = false;
    this.onunload();
  }
  onload(): void {}
  onunload(): void {}
  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    if (this.loaded) child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    const at = this.children.indexOf(child);
    if (at >= 0) {
      this.children.splice(at, 1);
      child.unload();
    }
    return child;
  }
}

/** Obsidian's own editor (not in its API; phase 17, as read in `app.js`
 * 1.14.4): built in an element for an owner; `set` the first time makes
 * its state from its extensions — its history, `readOnly.of(false)` and
 * `exceptionSink.of(console.error)` before its local ones —; `destroy`
 * empties it. */
export class FakeMarkdownEditor extends Component {
  readonly editorEl: HTMLElement;
  readonly cm: EditorView;
  readonly editor = { kind: "obsidian editor" };
  private localExtensions: Extension[] | null = null;
  options = 0;
  searches = 0;
  destroyed = false;
  constructor(
    readonly app: FakeApp,
    readonly containerEl: HTMLElement,
    readonly owner: unknown,
  ) {
    super();
    this.editorEl = document.createElement("div");
    this.editorEl.className = "markdown-source-view";
    containerEl.append(this.editorEl);
    this.cm = new EditorView({ parent: this.editorEl });
  }
  buildLocalExtensions(): Extension[] {
    return [history(), new Compartment().of(EditorState.readOnly.of(false))];
  }
  set(text: string): void {
    this.localExtensions ??= this.buildLocalExtensions();
    this.cm.setState(
      EditorState.create({
        doc: text,
        extensions: [
          EditorView.exceptionSink.of(console.error),
          this.localExtensions,
        ],
      }),
    );
  }
  updateOptions(): void {
    this.options++;
  }
  showSearch(): void {
    this.searches++;
  }
  destroy(): void {
    this.destroyed = true;
    this.cm.setState(EditorState.create({}));
    this.cm.destroy();
  }
}

/** The editor of an embedded note, whose prototype's prototype is
 * Obsidian's editor. */
class FakeEmbedEditor extends FakeMarkdownEditor {}

/** A key's handler, as Obsidian's keymap calls it. */
type KeyHandler = (event: KeyboardEvent, context: unknown) => unknown;

/** Obsidian's keymap scope: its handlers, kept for a test to call. */
export class Scope {
  readonly handlers: {
    modifiers: string[] | null;
    key: string | null;
    func: KeyHandler;
  }[] = [];
  constructor(readonly parent?: Scope) {}
  register(modifiers: string[] | null, key: string | null, func: KeyHandler) {
    const handler = { modifiers, key, func };
    this.handlers.push(handler);
    return handler;
  }
  unregister(handler: unknown): void {
    const at = this.handlers.indexOf(handler as Scope["handlers"][number]);
    if (at >= 0) this.handlers.splice(at, 1);
  }
}

/** Obsidian's keymap: its stack of scopes, the active one last. */
export class Keymap {
  readonly scopes: Scope[] = [];
  pushScope(scope: Scope): void {
    this.popScope(scope);
    this.scopes.push(scope);
  }
  popScope(scope: Scope): void {
    const at = this.scopes.indexOf(scope);
    if (at >= 0) this.scopes.splice(at, 1);
  }
}

export class FakeApp {
  /** Obsidian's embeds (not in its API); a test may take it away, as a
   * version of Obsidian might. */
  embedRegistry:
    | { embedByExtension: Record<string, (...args: unknown[]) => unknown> }
    | undefined = {
    embedByExtension: {
      md: (context: unknown) => {
        const { app, containerEl } = context as {
          app: FakeApp;
          containerEl: HTMLElement;
        };
        const embed = {
          editable: false,
          editMode: undefined as FakeEmbedEditor | undefined,
          load() {},
          showEditor() {
            embed.editMode = new FakeEmbedEditor(app, containerEl, embed);
            embed.editMode.set("");
          },
          unload() {
            embed.editMode?.destroy();
          },
        };
        return embed;
      },
    },
  };
  readonly vault = new Vault();
  readonly metadataCache = new MetadataCache(this.vault);
  readonly workspace: Workspace = new Workspace(this);
  readonly fileManager = new FileManager(this);
  readonly secretStorage = fakeSecrets();
  readonly appId = "vault-id";
  readonly scope = new Scope();
  readonly keymap = new Keymap();
  constructor() {
    this.workspace.creators.set("markdown", (leaf) => new MarkdownView(leaf));
    this.vault.on("delete", async (file) => {
      for (const leaf of [...this.workspace.leaves]) {
        if (leaf.view instanceof FileView && leaf.view.file === file) {
          await leaf.detach();
        }
      }
    });
  }
}
export { FakeApp as App };

export class WorkspaceLeaf {
  view: View | undefined;
  openedAs = "";
  constructor(readonly app: FakeApp) {}

  async setViewState(
    state: {
      type: string;
      state?: Record<string, unknown>;
      active?: boolean;
    },
    eState?: unknown,
  ): Promise<void> {
    if (this.view?.getViewType() !== state.type) {
      await this.view?.close();
      const create = this.app.workspace.creators.get(state.type);
      if (!create) throw new Error(`no view of type ${state.type}`);
      this.view = create(this);
      await this.view.open();
    }
    await this.view.setState(state.state ?? {}, { history: false });
    // As Obsidian: the ephemeral state once the view has its state.
    if (eState !== undefined) this.view.setEphemeralState(eState);
  }

  getViewState(): { type: string; state: Record<string, unknown> } {
    return {
      type: this.view?.getViewType() ?? "empty",
      state: (this.view?.getState() ?? {}) as Record<string, unknown>,
    };
  }

  async detach(): Promise<void> {
    await this.view?.close();
    this.view = undefined;
    const { leaves } = this.app.workspace;
    leaves.splice(leaves.indexOf(this), 1);
    if (this.app.workspace.activeLeaf === this) {
      this.app.workspace.activeLeaf = null;
    }
  }
}

export abstract class View {
  readonly app: FakeApp;
  readonly containerEl: HTMLElement;
  constructor(readonly leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    document.body.append(this.containerEl);
  }
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string {
    return "";
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  setEphemeralState(_state: unknown): void {}
  protected async onOpen(): Promise<void> {}
  protected async onClose(): Promise<void> {}
  async open(): Promise<void> {
    await this.onOpen();
  }
  async close(): Promise<void> {
    await this.onClose();
    this.containerEl.remove();
  }
}

export abstract class ItemView extends View {
  readonly contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = document.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.append(this.contentEl);
  }
}

export abstract class FileView extends ItemView {
  file: TFile | null = null;
  allowNoFile = false;
  override getDisplayText(): string {
    return this.file?.basename ?? "";
  }
  override getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }
  override async setState(state: unknown, result: unknown): Promise<void> {
    const path = (state as { file?: unknown }).file;
    if (typeof path === "string" && path !== this.file?.path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (this.file) await this.onUnloadFile(this.file);
      this.file = file instanceof TFile ? file : null;
      if (this.file) await this.onLoadFile(this.file);
    }
    await super.setState(state, result);
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(_file: TFile): Promise<void> {}
  override async close(): Promise<void> {
    if (this.file) await this.onUnloadFile(this.file);
    await super.close();
  }
}

/** Obsidian's own editor, as far as the tests see it: a file view. */
export class MarkdownView extends FileView {
  /** Editing ("source") or reading ("preview"). */
  mode = "source";
  getViewType(): string {
    return "markdown";
  }
  override getState(): Record<string, unknown> {
    return { ...super.getState(), mode: this.mode };
  }
  override async setState(state: unknown, result: unknown): Promise<void> {
    const { mode } = state as { mode?: unknown };
    if (mode === "source" || mode === "preview") this.mode = mode;
    await super.setState(state, result);
  }
}

export class Modal {
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  constructor(readonly app: FakeApp) {
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.titleEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.modalEl.append(this.titleEl, this.contentEl);
  }
  open(): void {
    document.body.append(this.modalEl);
    this.onOpen();
  }
  close(): void {
    this.onClose();
    this.modalEl.remove();
  }
  onOpen(): void {}
  onClose(): void {}
}

/** A list to choose from, filtered by what is typed: the tests call
 * `choose` with what they typed. */
export abstract class SuggestModal<T> extends Modal {
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
  setPlaceholder(_placeholder: string): void {}
  /** What the list shows for `query`, as rendered. */
  async shown(query: string): Promise<string[]> {
    return (await this.getSuggestions(query)).map((value) => {
      const el = document.createElement("div");
      this.renderSuggestion(value, el);
      return el.textContent ?? "";
    });
  }
  /** Chooses the `index`-th suggestion for `query`, and closes. */
  async choose(query: string, index = 0): Promise<void> {
    const item = (await this.getSuggestions(query))[index];
    if (item === undefined) throw new Error("no such suggestion");
    this.close();
    this.onChooseSuggestion(item, new MouseEvent("click"));
  }
}

class TextComponent {
  readonly inputEl: HTMLInputElement;
  private changed: ((value: string) => unknown) | undefined;
  constructor(parent: HTMLElement) {
    this.inputEl = document.createElement("input");
    parent.append(this.inputEl);
    this.inputEl.addEventListener("input", () =>
      this.changed?.(this.inputEl.value),
    );
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback;
    return this;
  }
}

class TextAreaComponent {
  readonly inputEl: HTMLTextAreaElement;
  private changed: ((value: string) => unknown) | undefined;
  constructor(parent: HTMLElement) {
    this.inputEl = document.createElement("textarea");
    parent.append(this.inputEl);
    this.inputEl.addEventListener("input", () =>
      this.changed?.(this.inputEl.value),
    );
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback;
    return this;
  }
}

class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) {
    this.buttonEl = document.createElement("button");
    parent.append(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

class DropdownComponent {
  readonly selectEl: HTMLSelectElement;
  private changed: ((value: string) => unknown) | undefined;
  constructor(parent: HTMLElement) {
    this.selectEl = document.createElement("select");
    parent.append(this.selectEl);
    this.selectEl.addEventListener("change", () =>
      this.changed?.(this.selectEl.value),
    );
  }
  addOption(value: string, display: string): this {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = display;
    this.selectEl.append(option);
    return this;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  onChange(callback: (value: string) => unknown): this {
    this.changed = callback;
    return this;
  }
}

class ToggleComponent {
  readonly toggleEl: HTMLInputElement;
  private changed: ((value: boolean) => unknown) | undefined;
  constructor(parent: HTMLElement) {
    this.toggleEl = document.createElement("input");
    this.toggleEl.type = "checkbox";
    parent.append(this.toggleEl);
    this.toggleEl.addEventListener("change", () =>
      this.changed?.(this.toggleEl.checked),
    );
  }
  setValue(value: boolean): this {
    this.toggleEl.checked = value;
    return this;
  }
  onChange(callback: (value: boolean) => unknown): this {
    this.changed = callback;
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    containerEl.append(this.settingEl);
  }
  setName(name: string): this {
    const element = document.createElement("div");
    element.className = "setting-item-name";
    element.textContent = name;
    this.settingEl.append(element);
    return this;
  }
  readonly descEl: HTMLElement = document.createElement("div");
  setDesc(desc: string): this {
    this.descEl.className = "setting-item-description";
    this.descEl.textContent = desc;
    this.settingEl.append(this.descEl);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  addTextArea(build: (text: TextAreaComponent) => unknown): this {
    build(new TextAreaComponent(this.settingEl));
    return this;
  }
  addToggle(build: (toggle: ToggleComponent) => unknown): this {
    build(new ToggleComponent(this.settingEl));
    return this;
  }
  addButton(build: (button: ButtonComponent) => unknown): this {
    build(new ButtonComponent(this.settingEl));
    return this;
  }
  addText(build: (text: TextComponent) => unknown): this {
    build(new TextComponent(this.settingEl));
    return this;
  }
  addDropdown(build: (dropdown: DropdownComponent) => unknown): this {
    build(new DropdownComponent(this.settingEl));
    return this;
  }
}

export abstract class PluginSettingTab {
  readonly containerEl: HTMLElement = document.createElement("div");
  constructor(
    readonly app: FakeApp,
    readonly plugin: Plugin,
  ) {}
  abstract display(): void;
}

interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | undefined;
}

export class Plugin extends Component {
  readonly commands: Command[] = [];
  /** The `obsidian://` handlers, by action. */
  readonly protocolHandlers = new Map<
    string,
    (params: Record<string, string>) => unknown
  >();
  readonly ribbon: { icon: string; title: string; run: () => unknown }[] = [];
  readonly settingTabs: PluginSettingTab[] = [];
  private readonly cleanups: (() => void)[] = [];
  data: unknown = null;
  constructor(
    readonly app: FakeApp,
    readonly manifest: { id: string },
  ) {
    super();
    this.loaded = true;
  }
  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  registerObsidianProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    this.protocolHandlers.set(action, handler);
    this.cleanups.push(() => this.protocolHandlers.delete(action));
  }
  addRibbonIcon(icon: string, title: string, run: () => unknown): HTMLElement {
    this.ribbon.push({ icon, title, run });
    return document.createElement("div");
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
  registerView(type: string, create: ViewCreator): void {
    this.app.workspace.creators.set(type, create);
  }
  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }
  registerEvent(ref: { off: () => void }): void {
    this.cleanups.push(() => ref.off());
  }
  async loadData(): Promise<unknown> {
    return structuredClone(this.data);
  }
  async saveData(data: unknown): Promise<void> {
    this.data = structuredClone(data);
  }
  override async onload(): Promise<void> {}
  override unload(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    super.unload();
  }
}
