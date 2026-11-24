// @vitest-environment jsdom
//
// The linked note (docs/phase-14-plugin-obsidian.md, decisions 3, 5, 6,
// 14–17; analysis 14c): "Open a link" creates a note in the plugin's
// folder and opens it in the plugin's view; the note's file is the
// export of its document, its link in `app.secretStorage`; opening the
// note opens the view; one live view per document; renamed, it follows;
// deleted or unlinked, nothing more is written, and the document is never
// deleted.
import { EditorView } from "@codemirror/view";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { IDBFactory } from "fake-indexeddb";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  createDocument,
  documentLinks,
  importKeyFromBase64Url,
  listKeyring,
  newKeyringDoc,
  newKeyringSecrets,
  openLink,
  prepareImage,
  rememberLink,
} from "../../web/lib/src/index.js";
import { FakeKeyringServer } from "../../web/lib/src/keyring/test-support/fake-keyring-server.js";
import { ActivityCount } from "../../web/lib/src/transport/test-support/activity-count.js";
import { eventually } from "../../web/lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../web/lib/src/transport/test-support/fake-server.js";
import {
  type KeyringLock,
  openDocument,
  openKeyringLocal,
  t,
} from "../../web/src/embed.js";
import { DOCUMENT_VIEW, DocumentLeafView } from "./leaf-view.js";
import { secretId, withFormerIds } from "./link-store.js";
import type { LiveViews } from "./live-views.js";
import CollabLink from "./main.js";
import { MY_DOCUMENTS_VIEW, MyDocumentsView } from "./my-documents-view.js";
import { formatVersion, readHeader, writeHeader } from "./note-header.js";
import { deviceSealKey } from "./seal-key.js";
import { FakeLocks } from "./test-support/locks.js";
import {
  FakeApp,
  type SuggestModal,
  type TFile,
  type WorkspaceLeaf,
  noticeFragments,
  notices,
  setFakeLanguage,
} from "./test-support/obsidian.js";
import type { VaultKeyring } from "./vault-keyring.js";

const ORIGIN = "https://collab.test";

async function newLinks(id: string) {
  const created = await createDocument(ORIGIN, async () =>
    Response.json({ document_id: id }),
  );
  return documentLinks(
    `${ORIGIN}/`,
    id,
    created.keyMaterial,
    created.editSecret,
  );
}

type Opened = Awaited<ReturnType<typeof openDocument>>;

/** The plugin, loaded in a fake Obsidian, its documents on a fake server;
 * a name already chosen (no dialog). */
async function loaded({
  named = true,
  app = new FakeApp(),
  server = new FakeServer(),
  data = undefined as unknown,
  before = (_plugin: CollabLink) => {},
} = {}) {
  const plugin = new CollabLink(app as never, { id: "collab-link" } as never);
  // What runs out of the test's hands, counted (AGENTS.md §1.6): the
  // plugin's timers and its documents' connections; its requests apart,
  // « Mes documents » keeping far timers (a token's end) a test can't wait
  // for.
  const activity = new ActivityCount();
  const requests = new ActivityCount();
  plugin.setTimer = activity.timers(plugin.setTimer);
  (plugin as unknown as { data: unknown }).data =
    data ??
    (named ? { preferences: { "obsidian-collab:pseudonym": "alice" } } : null);
  const opened: {
    options: Parameters<typeof openDocument>[0];
    document: Opened;
  }[] = [];
  plugin.openDocument = async (options) => {
    const document = await openDocument({
      ...options,
      socketFactory: () => server.connect(),
      activity,
    });
    opened.push({ options, document });
    return document;
  };
  plugin.exportDelayMs = 10;
  // The server's creation, and the brief connection of a share.
  const created: string[] = [];
  plugin.request = async (param) => {
    // The server's configuration, read for its push key (ADR-0060 §5):
    // none here, and not a creation.
    if (param.url.endsWith("/config.json")) {
      return { status: 404, headers: {}, text: "", json: null } as never;
    }
    created.push(JSON.stringify(param));
    const id = `shared-${created.length}`;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ document_id: id }),
      json: { document_id: id },
      arrayBuffer: new ArrayBuffer(0),
    } as never;
  };
  plugin.connect = (url) =>
    openLink(url, { socketFactory: () => server.connect() });
  before(plugin);
  plugin.request = requests.counted(plugin.request);
  await plugin.onload();
  loadedPlugins.push(plugin);
  const command = (id: string) => {
    const found = (
      plugin as unknown as {
        commands: {
          id: string;
          name: string;
          callback?: () => void;
          checkCallback?: (checking: boolean) => boolean | undefined;
        }[];
      }
    ).commands.find((c) => c.id === id);
    if (!found) throw new Error(`no command ${id}`);
    return found;
  };
  /** Runs "Open a link" with `text` pasted, and waits for its note's view
   * to show the document, unless that waits for the user. */
  const paste = async (text: string, { shown = true } = {}) => {
    command("open-link").callback?.();
    const modal = document.querySelector<HTMLElement>(".modal");
    const input = modal?.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no field for the link");
    input.value = text;
    modal?.querySelector<HTMLButtonElement>("button")?.click();
    await plugin.settled();
    if (shown) await Promise.all(views(app).map((view) => view.ready()));
  };
  /** Runs "Share this note" on the active note, and answers its dialog. */
  const share = async (answer: "confirm" | "cancel" = "confirm") => {
    command("share-note").checkCallback?.(false);
    const modal = document.querySelector<HTMLElement>(".modal");
    if (!modal) return undefined;
    const text = modal.textContent ?? "";
    modal
      .querySelector<HTMLButtonElement>(
        answer === "confirm" ? "button.mod-cta" : "button:not(.mod-cta)",
      )
      ?.click();
    await plugin.settled();
    await Promise.all(views(app).map((view) => view.ready()));
    return text;
  };
  /** Resolves once nothing runs: no timer of the plugin's pending, no
   * request, no task it was asked, nothing of its documents'
   * connections. */
  const rest = async () => {
    do {
      await activity.settled();
      await requests.settled();
      await plugin.settled();
    } while (activity.inProgress > 0 || requests.inProgress > 0);
  };
  /** Resolves once no request of the plugin's runs. */
  const answered = () => requests.settled();
  return {
    app,
    server,
    plugin,
    opened,
    command,
    paste,
    share,
    created,
    rest,
    answered,
  };
}

/** BroadcastChannel's semantics, delivered when the test says
 * (`deliverAll`), in the order posted: a message reaches every other
 * channel of its name, never the one that sent it. */
class ChannelBus {
  private readonly channels = new Set<{
    name: string;
    listeners: Set<(event: { data: unknown }) => void>;
  }>();
  private readonly queue: { name: string; data: unknown; from: object }[] = [];

  /** The `BroadcastChannel` class of this bus. */
  get Channel() {
    const bus = this;
    return class {
      private readonly entry: {
        name: string;
        listeners: Set<(event: { data: unknown }) => void>;
      };
      constructor(name: string) {
        this.entry = { name, listeners: new Set() };
        bus.channels.add(this.entry);
      }
      postMessage(data: unknown): void {
        bus.queue.push({ name: this.entry.name, data, from: this.entry });
      }
      addEventListener(
        _type: "message",
        listener: (event: { data: unknown }) => void,
      ) {
        this.entry.listeners.add(listener);
      }
      removeEventListener(
        _type: "message",
        listener: (event: { data: unknown }) => void,
      ) {
        this.entry.listeners.delete(listener);
      }
    };
  }

  deliverAll(): void {
    for (const message of this.queue.splice(0)) {
      for (const channel of this.channels) {
        if (channel.name !== message.name || channel === message.from) continue;
        for (const listener of channel.listeners)
          listener({ data: message.data });
      }
    }
  }
}

const views = (app: FakeApp) =>
  app.workspace.leaves
    .map((leaf: WorkspaceLeaf): unknown => leaf.view)
    .filter(
      (view): view is DocumentLeafView => view instanceof DocumentLeafView,
    );

/** The linked notes of the vault, by path, with their header. */
const notes = (app: FakeApp) =>
  app.vault.getMarkdownFiles().map((file: TFile) => ({
    path: file.path,
    ...readHeader(app.vault.text(file.path) ?? ""),
  }));

function typeIn(view: DocumentLeafView | undefined, text: string) {
  const element = view?.containerEl.querySelector<HTMLElement>(".cm-editor");
  const editor = element && EditorView.findFromDOM(element);
  if (!editor) throw new Error("no editor");
  editor.dispatch({
    changes: { from: editor.state.doc.length, insert: text },
  });
}

// What jsdom lacks: the boxes CodeMirror measures once asked to scroll (a
// heading revealed, phase 16).
const rangeRects = Range.prototype.getClientRects;
const rangeBox = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Range.prototype.getClientRects = rangeRects;
  Range.prototype.getBoundingClientRect = rangeBox;
});

beforeEach(() => {
  document.body.innerHTML = "";
  notices.length = 0;
  setFakeLanguage("en");
});
/** Unloaded after each test: each wraps `setViewState` (decision 15). */
const loadedPlugins: CollabLink[] = [];
afterEach(() => {
  for (const plugin of loadedPlugins.splice(0).reverse()) plugin.unload();
  vi.restoreAllMocks();
});

describe("Open a link", () => {
  test("creates a note in the plugin's folder, opens it in the view, and names it after the document", async () => {
    const { rest, app, paste } = await loaded();
    const links = await newLinks("doc");

    await paste(links.edit);
    typeIn(
      views(app)[0] as DocumentLeafView | undefined,
      "# Minutes\n\nFirst line.",
    );
    await rest();
    expect(
      (() => notes(app)[0]?.content === "# Minutes\n\nFirst line.")(),
    ).toBe(true);

    const [note] = notes(app);
    expect(note?.header?.document).toBe("doc");
    expect(views(app)).toHaveLength(1);
    expect(
      views(app)[0]?.containerEl.querySelector(".cm-editor"),
    ).not.toBeNull();
    // Renamed after its title, once known; in the plugin's folder.
    await rest();
    expect(notes(app)[0]?.path).toBe("Collab Link/Minutes.md");
    expect(document.querySelector(".modal")).toBeNull();
  });

  test("a new note follows its title as it is typed, not its first letter", async () => {
    const { rest, app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const view = views(app)[0];

    typeIn(view, "# M");
    await rest();
    expect(notes(app)[0]?.path).toBe("Collab Link/M.md");
    typeIn(view, "inutes");

    await rest();
    expect(notes(app)[0]?.path).toBe("Collab Link/Minutes.md");
  });

  test("renamed by the user, or reopened, a new note no longer follows its title", async () => {
    const { app, paste, rest } = await loaded();
    await paste((await newLinks("doc")).edit);
    let view = views(app)[0];
    typeIn(view, "# First");
    await rest();
    expect(notes(app)[0]?.path).toBe("Collab Link/First.md");
    const file = app.vault.getAbstractFileByPath("Collab Link/First.md");
    if (!file) throw new Error("no note");

    await app.fileManager.renameFile(file, "Mine.md");
    typeIn(view, " title");
    await rest();
    expect(notes(app)[0]?.path).toBe("Mine.md");

    await view?.leaf.detach();
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: "Mine.md" } });
    view = leaf.view as unknown as DocumentLeafView;
    await view.ready();
    typeIn(view, " again");
    await rest();
    expect(notes(app)[0]?.path).toBe("Mine.md");
  });

  test("keeps the link in Obsidian's secret storage: not in the note, data.json, nor the tab's state", async () => {
    const { app, plugin, paste } = await loaded();
    const links = await newLinks("doc");
    const parts = new URL(links.edit).hash
      .slice(1)
      .split(/[&=.]/)
      .filter((part) => part.length > 8);

    await paste(links.edit);

    const secrets = [...app.secretStorage.values.values()].join(" ");
    for (const part of parts) expect(secrets).toContain(part);
    const kept = [
      JSON.stringify(app.workspace.leaves.map((leaf) => leaf.getViewState())),
      JSON.stringify((plugin as unknown as { data: unknown }).data),
      ...notes(app).map(({ path }) => app.vault.text(path)),
    ].join(" ");
    for (const part of parts) expect(kept).not.toContain(part);
  });

  test("a document already linked to a note opens that note, and makes no other", async () => {
    const { app, paste } = await loaded();
    const links = await newLinks("doc");
    await paste(links.edit);
    await views(app)[0]?.leaf.detach();

    await paste(links.read);

    expect(notes(app)).toHaveLength(1);
    expect(views(app)).toHaveLength(1);
  });

  test("a note's name that exists gets a number", async () => {
    const { app, paste } = await loaded();
    await app.vault.createFolder("Collab Link");
    await app.vault.create("Collab Link/Shared document.md", "mine");

    await paste((await newLinks("doc")).edit);

    expect(app.vault.text("Collab Link/Shared document.md")).toBe("mine");
    expect(notes(app).map(({ path }) => path)).toContain(
      "Collab Link/Shared document 2.md",
    );
  });

  test("a link it can't open is said in a notice, and makes no note", async () => {
    const { app, paste } = await loaded();
    const links = await newLinks("doc");

    await paste(links.edit.replace("https:", "http:"));
    await paste("not a link");

    expect(notices).toEqual([t().pluginInsecureLink, t().pluginNotALink]);
    expect(notes(app)).toHaveLength(0);
  });

  test("a link opens while another still waits — for a name, or a server that doesn't answer", async () => {
    const { rest, app, paste } = await loaded({ named: false });

    await paste((await newLinks("first")).edit, { shown: false });
    // The first waits for its name: never given here.
    await rest();
    expect(
      (() => document.querySelector(".name-dialog[open]") !== null)(),
    ).toBe(true);
    await paste((await newLinks("second")).read, { shown: false });

    await rest();
    expect(
      (() =>
        views(app).some((view) =>
          view.containerEl.querySelector(".cm-editor"),
        ))(),
    ).toBe(true);
    expect(
      notes(app)
        .map(({ header }) => header?.document)
        .sort(),
    ).toEqual(["first", "second"]);
  });

  test("without a system keyring, says once that links are kept unencrypted (decision 5)", async () => {
    const app = new FakeApp();
    Object.assign(app.secretStorage, { isEncryptionAvailable: () => false });
    const first = await loaded({ app });

    await first.paste((await newLinks("one")).edit);
    await first.paste((await newLinks("two")).edit);
    // Obsidian started again: the same data.json.
    const again = await loaded({
      app,
      data: (first.plugin as unknown as { data: unknown }).data,
    });
    await again.paste((await newLinks("three")).edit);

    expect(notices).toEqual([t().pluginNoKeyring]);
  });

  test("a link that fails to open for any other reason says why, in a notice", async () => {
    const app = new FakeApp();
    Object.assign(app.secretStorage, {
      setSecret: () => {
        throw new Error("no room");
      },
    });
    const { paste } = await loaded({ app });

    await paste((await newLinks("doc")).edit);

    expect(notices).toEqual([t().pluginOpenFailed("no room")]);
  });

  test("speaks Obsidian's language", async () => {
    setFakeLanguage("fr");
    const { command } = await loaded();
    expect(command("open-link").name).toBe("Ouvrir un lien");
  });

  test("keeps the document on the device, in this vault's records", async () => {
    const { opened, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    expect(opened[0]?.options.local?.namespace).toBe("vault-id");
  });
});

describe("the vault's linked notes, kept by an index (LN1–LN3)", () => {
  /** The notes read while a link opens, in a vault of `n` other notes. */
  async function readsOpening(n: number) {
    const { app, paste, rest } = await loaded();
    for (let i = 0; i < n; i++) await app.vault.create(`note ${i}.md`, "text");
    await rest();
    const reads = vi.spyOn(app.vault, "cachedRead");
    await paste((await newLinks("doc")).edit);
    await rest();
    return reads.mock.calls.length;
  }

  test("opening a link reads as many notes whatever the vault's size (N, then 4N)", async () => {
    expect(await readsOpening(40)).toBe(await readsOpening(10));
  });
});

describe("a linked note", () => {
  test("opened as Obsidian opens any note, it shows in the plugin's view; an ordinary note doesn't", async () => {
    const { app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    await views(app)[0]?.leaf.detach();
    await app.vault.create("plain.md", "# Plain\n");

    const linked = app.workspace.getLeaf("tab");
    await linked.setViewState({
      type: "markdown",
      state: { file: note?.path },
    });
    const plain = app.workspace.getLeaf("tab");
    await plain.setViewState({ type: "markdown", state: { file: "plain.md" } });

    expect(linked.view?.getViewType()).toBe(DOCUMENT_VIEW);
    expect(plain.view?.getViewType()).toBe("markdown");
    // The class its styles are under (decisions 7 and 24).
    expect(
      (
        linked.view as DocumentLeafView | undefined
      )?.contentEl.classList.contains("collab-link-view"),
    ).toBe(true);
  });

  test("its header reformatted by another tool, it is still linked: it opens in the view, and Open a link finds it (decision 20)", async () => {
    const { app, opened, paste } = await loaded();
    const links = await newLinks("doc");
    await paste(links.edit);
    const [note] = notes(app);
    await views(app)[0]?.leaf.detach();
    const path = note?.path ?? "";
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    // As Obsidian's property editor writes them: no quotes, moved.
    await app.vault.modify(
      file,
      (app.vault.text(path) ?? "")
        .replace('collab-document: "doc"\n', "")
        .replace(
          /collab-version: "([^"]*)"\n/,
          "collab-version: $1\ncollab-document: doc\n",
        ),
    );

    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: path } });
    await (leaf.view as unknown as DocumentLeafView).ready();
    expect(leaf.view?.getViewType()).toBe(DOCUMENT_VIEW);
    expect(opened).toHaveLength(2);
    await leaf.detach();

    await paste(links.edit);
    expect(app.vault.getMarkdownFiles()).toHaveLength(1);
  });

  test("Obsidian's own reading view of it stays Obsidian's (decision 7)", async () => {
    const { app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);

    const preview = app.workspace.getLeaf("tab");
    await preview.setViewState({
      type: "markdown",
      state: { file: note?.path, mode: "preview" },
    });

    expect(preview.view?.getViewType()).toBe("markdown");
  });

  test("once the plugin is disabled, it opens as any note", async () => {
    const { app, plugin, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    plugin.unload();

    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: note?.path } });

    expect(leaf.view?.getViewType()).toBe("markdown");
  });

  test("in a second tab, it shows no second view, and leads to the first", async () => {
    const { app, opened, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    const first = views(app)[0]?.leaf;

    const second = app.workspace.getLeaf("tab");
    await second.setViewState({
      type: "markdown",
      state: { file: note?.path },
    });
    const view = second.view as unknown as DocumentLeafView;
    await view.ready();

    expect(opened).toHaveLength(1);
    expect(view.containerEl.querySelector(".cm-editor")).toBeNull();
    view.containerEl
      .querySelector<HTMLButtonElement>(".collab-link-go")
      ?.click();
    expect(app.workspace.activeLeaf).toBe(first);
  });

  test("synced to a device without its link, it asks for the link and connects nothing", async () => {
    const { app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    // Another device: the same vault's files, not its secrets.
    const elsewhere = new FakeApp();
    await elsewhere.vault.createFolder("Collab Link");
    await elsewhere.vault.create(
      note?.path ?? "",
      app.vault.text(note?.path ?? "") ?? "",
    );
    const other = await loaded({ app: elsewhere });

    const leaf = elsewhere.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: note?.path } });
    await (leaf.view as unknown as DocumentLeafView).ready();

    expect(leaf.view?.containerEl.textContent).toContain(t().pluginLinkNeeded);
    expect(other.opened).toHaveLength(0);
  });

  test("renamed, its export follows it", async () => {
    const { rest, app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const view = views(app)[0];
    await rest();
    expect(notes(app).length).toBe(1);
    const [note] = notes(app);
    const file = app.vault.getAbstractFileByPath(note?.path ?? "");
    if (!file) throw new Error("no note");

    await app.fileManager.renameFile(file, "Elsewhere.md");
    typeIn(view, "after the rename");

    await rest();
    expect(
      (() =>
        (app.vault.text("Elsewhere.md") ?? "").includes("after the rename"))(),
    ).toBe(true);
    expect(notes(app).map(({ path }) => path)).toEqual(["Elsewhere.md"]);
  });

  test("closed, what was just typed is in the note", async () => {
    const { app, plugin, paste } = await loaded();
    plugin.exportDelayMs = 60_000;
    await paste((await newLinks("doc")).edit);
    const view = views(app)[0];

    typeIn(view, "typed just before closing");
    await view?.leaf.detach();

    expect(notes(app)[0]?.content).toBe("typed just before closing");
  });

  test("reopened while its view still closes, it keeps the document on the device all the same (analysis 14c, 5)", async () => {
    const { app, plugin, paste } = await loaded();
    plugin.localStore = { indexedDB: new IDBFactory(), lock: new FakeLocks() };
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    typeIn(views(app)[0], "kept on the device");

    // Not waited for: the reopening runs into the closing.
    void views(app)[0]?.leaf.detach();
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: note?.path } });
    const view = leaf.view as unknown as DocumentLeafView;
    await view.ready();

    expect(view.containerEl.textContent).not.toContain(t().localOtherTab);
    expect(view.containerEl.querySelector(".cm-content")?.textContent).toBe(
      "kept on the device",
    );
  });

  describe("its tab shows another note while its document still opens (offline, a server that doesn't answer)", () => {
    /** Two linked notes, "one" and "two", their views closed; the
     * opening of a document held until `go(id)`. */
    async function twoNotes() {
      const s = await loaded();
      await s.paste((await newLinks("doc1")).edit);
      typeIn(views(s.app)[0], "one");
      await s.paste((await newLinks("doc2")).edit);
      typeIn(views(s.app)[1], "two");
      const path = (id: string) =>
        notes(s.app).find(({ header }) => header?.document === id)?.path ?? "";
      await eventually(
        () =>
          path("doc1") !== "" &&
          notes(s.app).every(
            ({ header, content }) =>
              content === (header?.document === "doc1" ? "one" : "two"),
          ),
      );
      for (const view of views(s.app)) await view.leaf.detach();
      const held = new Map<string, () => void>();
      const live = new Map<string, number>();
      const open = s.plugin.openDocument;
      s.plugin.openDocument = async (options) => {
        if (held.has(options.documentId)) {
          await new Promise<void>((go) => held.set(options.documentId, go));
        }
        const document = await open(options);
        // Open until closed: a view's connection, its lock.
        const { documentId } = options;
        live.set(documentId, (live.get(documentId) ?? 0) + 1);
        const close = document.close;
        document.close = () => {
          live.set(documentId, (live.get(documentId) ?? 0) - 1);
          return close();
        };
        return document;
      };
      const hold = (id: string) => held.set(id, () => {});
      // Waited for by the next view of the document: its claim resolves
      // once this opening has ended.
      const go = (id: string) => {
        held.get(id)?.();
        held.delete(id);
      };
      const show = async (leaf: WorkspaceLeaf, id: string) => {
        await leaf.setViewState({
          type: "markdown",
          state: { file: path(id) },
        });
        return leaf.view as unknown as DocumentLeafView;
      };
      const exported = () =>
        notes(s.app)
          .map(({ header, content }) => [header?.document, content])
          .sort();
      // Its history may arrive after it opens (no local record here).
      const shows = (view: View | null | undefined, text: string) =>
        view?.containerEl.querySelector(".cm-content")?.textContent === text;
      const opened = (id: string) => live.get(id) ?? 0;
      return { ...s, hold, go, show, exported, shows, opened, path };
    }

    type View = { containerEl: HTMLElement };

    test("the first document is free for another tab, and never written in the second note", async () => {
      const s = await twoNotes();
      s.hold("doc2");
      const leaf = s.app.workspace.getLeaf("tab");
      await s.show(leaf, "doc2");
      await (await s.show(leaf, "doc1")).ready();

      const other = await s.show(s.app.workspace.getLeaf("tab"), "doc2");
      // Its opening ends (online again): closed, nowhere shown.
      s.go("doc2");
      await other.ready();

      expect(other.containerEl.textContent).not.toContain(
        t().pluginOpenElsewhere,
      );
      await eventually(() => s.shows(other, "two"));
      await eventually(() => s.shows(leaf.view, "one"));
      expect(
        leaf.view?.containerEl.querySelectorAll(".cm-editor"),
      ).toHaveLength(1);
      typeIn(other, " more");
      await eventually(() =>
        notes(s.app).some(({ content }) => content === "two more"),
      );
      expect(s.exported()).toEqual([
        ["doc1", "one"],
        ["doc2", "two more"],
      ]);
      expect([s.opened("doc1"), s.opened("doc2")]).toEqual([1, 1]);
    });

    test("nothing of it said in the tab, refused or failed", async () => {
      const s = await twoNotes();
      const holder = s.app.workspace.getLeaf("tab");
      await (await s.show(holder, "doc2")).ready();
      // Refused: another tab holds it.
      const leaf = s.app.workspace.getLeaf("tab");
      s.hold("doc1");
      await s.show(leaf, "doc1");
      await s.show(leaf, "doc2");
      const view = await s.show(leaf, "doc1");
      s.go("doc1");
      await view.ready();
      expect(leaf.view?.containerEl.textContent).not.toContain(
        t().pluginOpenElsewhere,
      );
      await eventually(() => s.shows(leaf.view, "one"));
    });

    test("shown again in the same tab, it opens once its first opening is closed", async () => {
      const s = await twoNotes();
      s.hold("doc2");
      const leaf = s.app.workspace.getLeaf("tab");
      await s.show(leaf, "doc2");
      await s.show(leaf, "doc1");
      const again = await s.show(leaf, "doc2");
      s.go("doc2");
      await again.ready();

      await eventually(() => s.shows(again, "two"));
      expect(again.containerEl.querySelectorAll(".cm-editor")).toHaveLength(1);
      // Still its document's: another tab is led to it.
      const other = await s.show(s.app.workspace.getLeaf("tab"), "doc2");
      await other.ready();
      expect(other.containerEl.textContent).toContain(t().pluginOpenElsewhere);
      expect(s.exported()).toEqual([
        ["doc1", "one"],
        ["doc2", "two"],
      ]);
      // Its first opening closed: one connection, one lock.
      expect([s.opened("doc1"), s.opened("doc2")]).toEqual([0, 1]);
    });

    test("whatever the order of the tabs' gestures and of the openings' ends: one opening per document, its own note's, each note its own document's", async () => {
      const s = await twoNotes();
      const DOCS = ["doc1", "doc2"] as const;
      const TEXT = { doc1: "one", doc2: "two" };
      // Each opening held back until the scenario lets it through.
      const inner = s.plugin.openDocument;
      const holding = new Set<string>();
      const waiting = new Map<string, (() => void)[]>();
      const problems: string[] = [];
      s.plugin.openDocument = async (options) => {
        const id = options.documentId;
        if (holding.has(id)) {
          await new Promise<void>((go) =>
            waiting.set(id, [...(waiting.get(id) ?? []), go]),
          );
        }
        const document = await inner(options);
        // At every moment, not only at rest.
        if (s.opened(id) > 1) problems.push(`${id} opened twice`);
        return document;
      };
      const release = (id: string) => {
        holding.delete(id);
        for (const go of waiting.get(id)?.splice(0) ?? []) go();
      };
      const holders = (
        s.plugin as unknown as { views: LiveViews<DocumentLeafView> }
      ).views;
      const seen = new Set<DocumentLeafView>();
      const idle = async () => {
        for (const id of DOCS) release(id);
        await Promise.all([...seen].map((view) => view.idle()));
      };
      await hegel.testAsync(
        async (tc) => {
          const leaves: (WorkspaceLeaf | undefined)[] = [undefined, undefined];
          try {
            const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
            for (let i = 0; i < steps; i++) {
              const move = tc.draw(
                gs.sampledFrom(["show", "hold", "release", "close"] as const),
              );
              if (move === "show") {
                const at = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
                const id = tc.draw(gs.sampledFrom(DOCS));
                const leaf = leaves[at] ?? s.app.workspace.getLeaf("tab");
                leaves[at] = leaf;
                seen.add(await s.show(leaf, id));
              } else if (move === "hold") {
                holding.add(tc.draw(gs.sampledFrom(DOCS)));
              } else if (move === "release") {
                release(tc.draw(gs.sampledFrom(DOCS)));
              } else {
                const at = tc.draw(gs.integers({ minValue: 0, maxValue: 1 }));
                await leaves[at]?.detach();
                leaves[at] = undefined;
              }
            }
            await idle();
            expect(problems).toEqual([]);
            for (const id of DOCS) {
              const holder = holders.live(id);
              if (!holder) {
                expect(s.opened(id)).toBe(0);
                continue;
              }
              // Held by a tab that shows its note: never one that moved on.
              expect(
                leaves.some((leaf) => (leaf?.view as unknown) === holder),
              ).toBe(true);
              expect(holder.file?.path).toBe(s.path(id));
              expect(s.opened(id)).toBe(1);
              await eventually(() => s.shows(holder, TEXT[id]));
            }
            await eventually(
              () =>
                JSON.stringify(s.exported()) ===
                JSON.stringify([
                  ["doc1", "one"],
                  ["doc2", "two"],
                ]),
            );
          } finally {
            for (const leaf of leaves) await leaf?.detach();
            await idle();
            problems.length = 0;
          }
        },
        { testCases: 40 },
      );
    }, 300_000);
  });

  test("deleted, its view closes and nothing writes it again; the document stays", async () => {
    const { app, opened, paste, rest } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [note] = notes(app);
    const file = app.vault.getAbstractFileByPath(note?.path ?? "");
    const deleted = vi.spyOn(
      opened[0]?.document.connection ?? {},
      "deleteDocument" as never,
    );

    await app.vault.delete(file as TFile);
    await rest();

    expect(views(app)).toHaveLength(0);
    expect(notes(app)).toHaveLength(0);
    expect(deleted).not.toHaveBeenCalled();
  });

  test("unlinked, it is an ordinary note with its last export; the link is forgotten, the document stays", async () => {
    const { rest, app, opened, command, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const view = views(app)[0];
    typeIn(view, "the last text");
    const deleted = vi.spyOn(
      opened[0]?.document.connection ?? {},
      "deleteDocument" as never,
    );
    if (view)
      app.workspace.setActiveLeaf(view.leaf as unknown as WorkspaceLeaf);

    expect(command("unlink-note").checkCallback?.(true)).toBe(true);
    command("unlink-note").checkCallback?.(false);
    await rest();
    expect(views(app).length).toBe(0);

    const file = app.vault.getMarkdownFiles()[0];
    expect(app.vault.text(file?.path ?? "")).toBe("the last text");
    expect(app.workspace.activeLeaf?.view?.getViewType()).toBe("markdown");
    expect([...app.secretStorage.values.values()].every((v) => v === "")).toBe(
      true,
    );
    expect(deleted).not.toHaveBeenCalled();
  });

  test("its attached images are written to the vault, and its file cites them; turned off, attachment: again (ADR-0058)", async () => {
    const created = await createDocument(ORIGIN, async () =>
      Response.json({ document_id: "doc" }),
    );
    const links = await documentLinks(
      `${ORIGIN}/`,
      "doc",
      created.keyMaterial,
      created.editSecret,
    );
    const key = await importKeyFromBase64Url(created.keyMaterial);
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const prepared = await prepareImage(key, "doc", png);
    if (typeof prepared === "string") throw new Error(prepared);
    const id = prepared.attachmentId;
    const asked: string[] = [];
    const { rest, app, plugin, paste } = await loaded({
      before: (plugin) => {
        plugin.request = async (param) => {
          asked.push(`${param.method} ${param.url}`);
          return {
            status: 200,
            headers: {},
            text: "",
            json: null,
            arrayBuffer: prepared.blob.slice().buffer,
          } as never;
        };
      },
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await paste(links.edit);
    const view = views(app)[0];
    typeIn(view, `![a dog](attachment:${id})`);

    const path = `Collab Link/images/doc/${id}.png`;
    await rest();
    expect(app.vault.binaries.has(path)).toBe(true);
    expect(app.vault.binaries.get(path)).toEqual(prepared.bytes);
    expect(asked.filter((a) => !a.endsWith("/config.json"))).toEqual([
      `GET ${ORIGIN}/documents/doc/attachments/${id}`,
    ]);
    await rest();
    expect(
      (() =>
        notes(app)[0]?.content ===
        `![a dog](Collab%20Link/images/doc/${id}.png)`)(),
    ).toBe(true);

    const tab = (
      plugin as unknown as {
        settingTabs: { display(): void; containerEl: HTMLElement }[];
      }
    ).settingTabs[0];
    tab?.display();
    const toggle = tab?.containerEl.querySelector<HTMLInputElement>(
      "input[type=checkbox]",
    );
    if (!toggle) throw new Error("no setting");
    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await plugin.settled();

    await rest();
    expect(
      (() => notes(app)[0]?.content === `![a dog](attachment:${id})`)(),
    ).toBe(true);
    expect(app.vault.binaries.has(path)).toBe(true);
    expect(
      JSON.stringify((plugin as unknown as { data: unknown }).data),
    ).toContain('"vaultImages":false');
  });

  test("the folder for new notes is a setting, kept in data.json", async () => {
    const { app, plugin, paste } = await loaded();
    const tab = (
      plugin as unknown as {
        settingTabs: { display(): void; containerEl: HTMLElement }[];
      }
    ).settingTabs[0];
    tab?.display();
    // Server, name, password, then the folder.
    const input = tab?.containerEl.querySelectorAll("input")[3];
    if (!input) throw new Error("no setting");
    input.value = "Shared";
    input.dispatchEvent(new Event("input"));
    await plugin.settled();

    await paste((await newLinks("doc")).edit);

    expect(notes(app)[0]?.path.startsWith("Shared/")).toBe(true);
    expect(
      JSON.stringify((plugin as unknown as { data: unknown }).data),
    ).toContain('"folder":"Shared"');
  });
});

describe("« Mes documents » and signing in the views (phase 18, analysis 18m: M1, M2, M7)", () => {
  /** One holder at a time per name, in arrival order. */
  const memoryLock = (): KeyringLock => {
    const tails = new Map<string, Promise<unknown>>();
    return {
      exclusive(name, run) {
        const result = (tails.get(name) ?? Promise.resolve()).then(run, run);
        tails.set(
          name,
          result.catch(() => {}),
        );
        return result as never;
      },
    };
  };
  const KEYRING_ID = "ab".repeat(16);

  /** The plugin on a vault whose device holds a keyring already (as
   * « Mes documents » will make it, 18m.3), the server set. */
  async function withKeyring(
    options: { canSign?: boolean; data?: Record<string, unknown> } = {},
  ) {
    const app = new FakeApp();
    const indexedDB = new IDBFactory();
    const keyringLock = memoryLock();
    const sealKey = await deviceSealKey(
      withFormerIds(app.secretStorage),
      keyringLock,
    );
    const local = () =>
      openKeyringLocal({
        indexedDB,
        lock: keyringLock,
        namespace: "vault-id",
        sealKey,
      });
    await local().replace(
      { keyringId: KEYRING_ID, ...newKeyringSecrets() },
      newKeyringDoc(),
    );
    const asked: string[] = [];
    const loadedPlugin = await loaded({
      app,
      data: {
        preferences: { "obsidian-collab:pseudonym": "alice" },
        server: "https://collab.test",
        ...options.data,
      },
      before: (plugin) => {
        plugin.localStore = {
          indexedDB,
          lock: new FakeLocks(),
          keyringLock,
        };
        if (options.canSign === false) plugin.ed25519 = async () => false;
        plugin.request = async (param) => {
          asked.push(param.url);
          if (param.url.endsWith("/config.json")) {
            // The server names an attestation key: never trusted (OB3).
            const json = { attestationKeys: ["c".repeat(64)] };
            return {
              status: 200,
              headers: {},
              text: JSON.stringify(json),
              json,
            } as never;
          }
          return {
            status: 404,
            headers: {},
            text: "",
            json: null,
            arrayBuffer: new ArrayBuffer(0),
          } as never;
        };
      },
    });
    return { ...loadedPlugin, local, asked };
  }

  /** A comment on the start of the first view's text. */
  function comment(opened: Awaited<ReturnType<typeof loaded>>["opened"]) {
    const document = opened[0]?.document;
    if (!document) throw new Error("not opened");
    const { editor, panel } = document.client;
    editor.view.dispatch({ changes: { from: 0, insert: "Bonjour" } });
    editor.view.dispatch({ selection: { anchor: 0, head: 7 } });
    panel.create("comment", "?", "");
    return document.annotationsDoc;
  }

  test("a note opened enters the vault's list, kept sealed on the device", async () => {
    const { paste, local } = await withKeyring();
    await paste((await newLinks("doc")).edit);
    await vi.waitFor(async () => {
      const stored = await local().load();
      expect(
        listKeyring(stored?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["doc"]);
    });
  });

  test("what is written is signed, with the vault's key", async () => {
    const { paste, opened } = await withKeyring();
    await paste((await newLinks("doc")).edit);
    const annotations = comment(opened);
    await vi.waitFor(() =>
      expect(annotations.getMap("identities").size).toBe(1),
    );
  });

  test("without Ed25519, nothing is signed", async () => {
    const { paste, opened } = await withKeyring({ canSign: false });
    await paste((await newLinks("doc")).edit);
    const annotations = comment(opened);
    await vi.waitFor(() =>
      expect(annotations.getMap("annotations").size).toBeGreaterThan(0),
    );
    expect(annotations.getMap("identities").size).toBe(0);
  });

  // /config.json is read for its push key alone (ADR-0060 §5, phase 34h):
  // the attestation key it names is never trusted.
  test("OB3: the trust is the settings', never the server's /config.json", async () => {
    const without = await withKeyring();
    await without.paste((await newLinks("doc")).edit);
    await vi.waitFor(() =>
      expect(without.asked.some((url) => url.endsWith("/config.json"))).toBe(
        true,
      ),
    );
    await without.plugin.settled();
    expect(without.asked.some((url) => url.endsWith("/revocations"))).toBe(
      false,
    );

    const trusted = await withKeyring({
      data: {
        attestationKeys: "a".repeat(64),
        server: "https://keys.test",
      },
    });
    await trusted.paste((await newLinks("doc")).edit);
    await vi.waitFor(() =>
      expect(trusted.asked).toContain("https://keys.test/revocations"),
    );
  });

  // Found at the real trial (2026-10-22): the view's « Ouvrir votre liste
  // ici » opened the home page in the browser, another device's list.
  test("a view's way to « Mes documents » is the vault's, not the browser's", async () => {
    const { app, plugin } = await withKeyring();
    const { keyring } = plugin as unknown as { keyring: VaultKeyring };
    const target = await keyring.documentIdentity("doc", "https://collab.test");
    target.openHome?.();
    await plugin.settled();
    expect(app.workspace.getLeavesOfType(MY_DOCUMENTS_VIEW)).toHaveLength(1);
  });
});

describe("the view « Mes documents » and signing in (phase 18, analysis 18m: M5, M6, ID-41)", () => {
  const GATEWAY = "https://accounts.test";
  const memoryLock = (): KeyringLock => {
    const tails = new Map<string, Promise<unknown>>();
    return {
      exclusive(name, run) {
        const result = (tails.get(name) ?? Promise.resolve()).then(run, run);
        tails.set(
          name,
          result.catch(() => {}),
        );
        return result as never;
      },
    };
  };
  type Sent = Parameters<CollabLink["request"]>[0];

  /** The plugin with a keyring server, and a gateway that signs in
   * whoever brings a code (ID-21). */
  async function withServers(data: Record<string, unknown> = {}) {
    const app = new FakeApp();
    const indexedDB = new IDBFactory();
    const keyringLock = memoryLock();
    const keyrings = new FakeKeyringServer();
    const sent: Sent[] = [];
    const windows: string[] = [];
    const loadedPlugin = await loaded({
      app,
      data: {
        preferences: { "obsidian-collab:pseudonym": "alice" },
        server: ORIGIN,
        ...data,
      },
      before: (plugin) => {
        plugin.localStore = { indexedDB, lock: new FakeLocks(), keyringLock };
        plugin.openExternal = (url) => windows.push(url);
        plugin.request = async (param) => {
          sent.push(param);
          const answer = (status: number, json?: unknown) =>
            ({
              status,
              headers: {},
              text: json === undefined ? "" : JSON.stringify(json),
              json: json ?? null,
              arrayBuffer: new ArrayBuffer(0),
            }) as never;
          if (param.url === `${GATEWAY}/accounts/health`)
            return answer(200, {});
          if (param.url === `${GATEWAY}/accounts/session`) {
            return answer(200, {
              token: "A".repeat(43),
              expires_at: 1,
              name: "Ada Lovelace",
              email: "ada@example.org",
              issuer: "https://idp.test",
              sub: "u-1",
            });
          }
          if (param.url.startsWith(GATEWAY)) return answer(404);
          const response = await keyrings.fetch(param.url, {
            method: param.method ?? "GET",
            ...(param.headers && { headers: param.headers }),
            ...(param.body !== undefined && {
              body: param.body as BodyInit,
            }),
          });
          const bytes = await response.arrayBuffer();
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            headers[name] = value;
          });
          return {
            status: response.status,
            headers,
            arrayBuffer: bytes,
            text: new TextDecoder().decode(bytes),
            json: null,
          } as never;
        };
      },
    });
    const sealKey = await deviceSealKey(
      withFormerIds(app.secretStorage),
      keyringLock,
    );
    const local = () =>
      openKeyringLocal({
        indexedDB,
        lock: keyringLock,
        namespace: "vault-id",
        sealKey,
      });
    const openMyDocuments = async () => {
      loadedPlugin.command("my-documents").callback?.();
      await loadedPlugin.plugin.settled();
      const view = app.workspace
        .getLeavesOfType(MY_DOCUMENTS_VIEW)
        .map((leaf: WorkspaceLeaf): unknown => leaf.view)
        .find((v): v is MyDocumentsView => v instanceof MyDocumentsView);
      if (!view) throw new Error("no « Mes documents »");
      await view.ready();
      return view;
    };
    return { ...loadedPlugin, app, sent, windows, local, openMyDocuments };
  }

  const within = (view: MyDocumentsView) => ({
    $: <T extends Element = HTMLElement>(selector: string) =>
      view.contentEl.querySelector<T>(selector),
    click(selector: string) {
      view.contentEl
        .querySelector(selector)
        ?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    },
  });

  test("kept here: its key shown once; a note then opened enters it; the server's name and password sent", async () => {
    const { plugin, app, sent, local, paste, openMyDocuments } =
      await withServers({ user: "alice" });
    app.secretStorage.setSecret(secretId("setting", "password"), "pw");
    const view = await openMyDocuments();
    const { $, click } = within(view);
    expect($(".home-new")).toBeNull();
    click(".home-keep");
    await eventually(() => $(".home-key") !== null);
    const creation = sent.find(
      (param) => param.url === `${ORIGIN}/keyrings` && param.method === "POST",
    );
    expect(creation?.headers?.Authorization).toMatch(/^Basic /);
    await plugin.settled();
    await paste((await newLinks("doc")).edit);
    await vi.waitFor(async () => {
      const stored = await local().load();
      expect(
        listKeyring(stored?.doc ?? newKeyringDoc()).map((e) => e.documentId),
      ).toEqual(["doc"]);
    });
  });

  test("an entry opens its note in the view, not the address", async () => {
    const { app, local, opened, openMyDocuments, plugin } = await withServers();
    const doc = newKeyringDoc();
    rememberLink(doc, (await newLinks("doc")).edit, { at: 1 });
    await local().replace(
      { keyringId: "ab".repeat(16), ...newKeyringSecrets() },
      doc,
    );
    const view = await openMyDocuments();
    const { $, click } = within(view);
    await eventually(() => $(".home-entry-link") !== null);
    click(".home-entry-link");
    await plugin.settled();
    await Promise.all(views(app).map((v) => v.ready()));
    expect(notes(app).map((note) => note.header?.document)).toEqual(["doc"]);
    expect(opened).toHaveLength(1);
  });

  test("an address of a document of the list, no note here: opened as an entry is, in a note of its own, once for two clicks (phase 19, decision 6)", async () => {
    const original = window.open;
    const sent: string[] = [];
    window.open = ((url?: string | URL) => {
      sent.push(String(url));
      return null;
    }) as typeof window.open;
    onTestFinished(() => {
      window.open = original;
    });
    const { app, local, opened, plugin } = await withServers();
    const doc = newKeyringDoc();
    rememberLink(doc, (await newLinks("doc")).edit, { at: 1 });
    await local().replace(
      { keyringId: "ab".repeat(16), ...newKeyringSecrets() },
      doc,
    );

    window.open(`${ORIGIN}/?doc=doc`);
    window.open(`${ORIGIN}/?doc=doc`);
    await plugin.settled();
    await Promise.all(views(app).map((v) => v.ready()));

    expect(sent).toEqual([]);
    expect(notes(app).map((note) => note.header?.document)).toEqual(["doc"]);
    expect(opened).toHaveLength(1);
  });

  test("M6: « Ouvrir un document de Mes documents » lists them, and opens the one chosen", async () => {
    const { app, local, command, plugin } = await withServers();
    const doc = newKeyringDoc();
    rememberLink(doc, (await newLinks("doc")).edit, { at: 1 });
    await local().replace(
      { keyringId: "ab".repeat(16), ...newKeyringSecrets() },
      doc,
    );
    await plugin.settled();
    command("open-from-my-documents").callback?.();
    const modal = await vi.waitFor(() => {
      const found = plugin.suggesting;
      if (!found) throw new Error("no list");
      // The fake's: what the list shows, and a choice.
      return found as unknown as SuggestModal<unknown>;
    });
    expect(await modal.shown("")).toEqual([t().untitled]);
    await modal.choose("");
    await plugin.settled();
    await Promise.all(views(app).map((v) => v.ready()));
    expect(notes(app).map((note) => note.header?.document)).toEqual(["doc"]);
  });

  test("ID-41: signing in opens the system's browser; its return by obsidian:// signs in", async () => {
    // The channels between the vault's windows, delivering when the test
    // says: each return posts from a channel of its own, which nothing
    // orders with another's.
    const bus = new ChannelBus();
    vi.stubGlobal("BroadcastChannel", bus.Channel);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { plugin, windows, sent, answered, openMyDocuments } =
      await withServers({
        gateway: GATEWAY,
        attestationKeys: "a".repeat(64),
      });
    const view = await openMyDocuments();
    const { $, click } = within(view);
    await eventually(
      () => !($<HTMLButtonElement>(".home-sign-in")?.disabled ?? true),
    );
    click(".home-sign-in");
    expect(windows).toHaveLength(1);
    const address = new URL(windows[0] as string);
    expect(address.origin + address.pathname).toBe(`${GATEWAY}/accounts/login`);
    expect(address.searchParams.get("client")).toBe("obsidian");
    const request = address.searchParams.get("request") ?? "";
    const handler = (
      plugin as unknown as {
        protocolHandlers: Map<string, (params: Record<string, string>) => void>;
      }
    ).protocolHandlers.get("collab-link-auth");
    // Forged, of another attempt, or without the action: nothing (a code
    // of their own, to tell their exchange from the right one's).
    handler?.({
      action: "collab-link-auth",
      code: "g".repeat(43),
      request: "0".repeat(32),
    });
    handler?.({
      action: "collab-link-auth",
      hash: `code=${"g".repeat(43)}&request=${request}`,
    });
    const exchanged = () =>
      sent
        .filter((param) => param.url === `${GATEWAY}/accounts/session`)
        .map((param) => JSON.parse(String(param.body)).code);
    bus.deliverAll();
    await answered();
    expect(exchanged()).toEqual([]);
    expect($(".home-signed-in")).toBeNull();
    handler?.({ action: "collab-link-auth", code: "c".repeat(43), request });
    bus.deliverAll();
    await eventually(() => $(".home-signed-in") !== null);
    expect($(".home-signed-in")?.textContent).toContain("Ada Lovelace");
    expect(exchanged()).toEqual(["c".repeat(43)]);
  });
});

describe("the identity's settings (phase 18, analysis 18m: M3, OB3)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  async function settings(options: Parameters<typeof loaded>[0] = {}) {
    const loadedPlugin = await loaded(options);
    const tab = (
      loadedPlugin.plugin as unknown as {
        settingTabs: { display(): void; containerEl: HTMLElement }[];
      }
    ).settingTabs[0];
    if (!tab) throw new Error("no settings");
    tab.display();
    const field = (name: string) => {
      const setting = Array.from(
        tab.containerEl.querySelectorAll<HTMLElement>(".setting-item"),
      ).find(
        (item) =>
          item.querySelector(".setting-item-name")?.textContent === name,
      );
      if (!setting) throw new Error(`no setting ${name}`);
      return setting;
    };
    const type = (name: string, value: string) => {
      const input = field(name).querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea");
      if (!input) throw new Error(`no field ${name}`);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    const data = () =>
      (loadedPlugin.plugin as unknown as { data: Record<string, unknown> })
        .data;
    return { ...loadedPlugin, tab, field, type, data };
  }

  test("the gateway and the fingerprints, typed, kept in data.json", async () => {
    const { plugin, type, data } = await settings();
    type(t().pluginGateway, "https://accounts.example.org");
    type(t().pluginAttestationKeys, `${A}\n${B}`);
    await plugin.settled();
    expect(data().gateway).toBe("https://accounts.example.org");
    expect(data().attestationKeys).toBe(`${A}\n${B}`);
    expect(plugin.trust()).toEqual({
      gateway: "https://accounts.example.org",
      attestationKeys: [A, B],
    });
  });

  test("a line that isn't a fingerprint is said, and nothing is trusted", async () => {
    const { plugin, type, field } = await settings();
    type(t().pluginAttestationKeys, `${A}\nnot one`);
    expect(field(t().pluginAttestationKeys).textContent).toContain(
      t().pluginAttestationKeysBad(2),
    );
    expect(plugin.trust()).toBeUndefined();
    type(t().pluginAttestationKeys, A);
    expect(field(t().pluginAttestationKeys).textContent).not.toContain(
      t().pluginAttestationKeysBad(2),
    );
  });

  test("read from the server: shown, kept only once confirmed", async () => {
    const { plugin, type, field, data } = await settings();
    type(t().pluginServer, "https://collab.test");
    const asked: string[] = [];
    plugin.request = async (param) => {
      asked.push(param.url);
      const json = {
        gateway: "https://accounts.example.org",
        attestationKeys: [A],
        orgName: "Systerel",
      };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify(json),
        json,
        arrayBuffer: new ArrayBuffer(0),
      } as never;
    };
    const read = async (answer: "confirm" | "cancel") => {
      field(t().pluginReadFromServer)
        .querySelector<HTMLButtonElement>("button")
        ?.click();
      await eventually(() => document.querySelector(".modal") !== null);
      const modal = document.querySelector<HTMLElement>(".modal");
      const text = modal?.textContent ?? "";
      const buttons = Array.from(modal?.querySelectorAll("button") ?? []);
      buttons
        .find(
          (button) =>
            button.textContent ===
            (answer === "confirm" ? t().pluginTrustConfirm : t().pluginCancel),
        )
        ?.click();
      await plugin.settled();
      return text;
    };
    const said = await read("cancel");
    expect(asked).toEqual(["https://collab.test/config.json"]);
    expect(said).toContain("https://accounts.example.org");
    expect(said).toContain(A);
    expect(said).toContain(t().pluginTrustCompare);
    expect(plugin.trust()).toBeUndefined();
    expect(data().gateway).toBeUndefined();

    await read("confirm");
    expect(plugin.trust()).toEqual({
      gateway: "https://accounts.example.org",
      attestationKeys: [A],
      orgName: "Systerel",
    });
    // Shown in the fields, as if typed.
    expect(
      field(t().pluginAttestationKeys).querySelector("textarea")?.value,
    ).toBe(A);
  });

  test("a server that cannot be read: said so, nothing changed", async () => {
    const { rest, plugin, type, field, data } = await settings();
    type(t().pluginServer, "https://collab.test");
    plugin.request = async () =>
      ({
        status: 404,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      }) as never;
    field(t().pluginReadFromServer)
      .querySelector<HTMLButtonElement>("button")
      ?.click();
    await rest();
    expect(
      notices.includes(t().pluginServerUnreadable("https://collab.test")),
    ).toBe(true);
    expect(notices).not.toContain(t().pluginServerNamesNoGateway);
    expect(document.querySelector(".modal")).toBeNull();
    expect(data().attestationKeys).toBeUndefined();
  });

  test("the name and password, tested without creating anything", async () => {
    const { rest, plugin, type, field } = await settings();
    const test = async () => {
      notices.length = 0;
      field(t().pluginCheckCredentials)
        .querySelector<HTMLButtonElement>("button")
        ?.click();
      await plugin.settled();
      await rest();
      expect(notices.length > 0).toBe(true);
      return notices[0];
    };
    expect(await test()).toBe(t().pluginNoServer);
    type(t().pluginServer, "https://collab.test");
    const sent: { url: string; method?: string }[] = [];
    plugin.request = async (param) => {
      sent.push(param);
      const status = param.headers?.Authorization ? 405 : 401;
      return {
        status,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      } as never;
    };
    expect(await test()).toBe(t().pluginCredentialsMissing);
    type(t().pluginUser, "alice");
    type(t().pluginPassword, "secret");
    expect(await test()).toBe(t().pluginCredentialsAccepted);
    expect(sent.at(-1)).toMatchObject({
      url: "https://collab.test/documents",
      method: "GET",
    });
    expect(sent.every((request) => request.method === "GET")).toBe(true);
  });

  test("a server that answers without keys: said, nothing changed", async () => {
    const { rest, plugin, type, field, data } = await settings();
    type(t().pluginServer, "https://collab.test");
    plugin.request = async () =>
      ({
        status: 200,
        headers: {},
        text: "{}",
        json: {},
        arrayBuffer: new ArrayBuffer(0),
      }) as never;
    field(t().pluginReadFromServer)
      .querySelector<HTMLButtonElement>("button")
      ?.click();
    await rest();
    expect(notices.includes(t().pluginServerNamesNoGateway)).toBe(true);
    expect(document.querySelector(".modal")).toBeNull();
    expect(data().attestationKeys).toBeUndefined();
  });

  test("Ed25519 missing: said once, and the plugin knows it can't sign", async () => {
    const app = new FakeApp();
    const { plugin } = await loaded({
      app,
      before: (p) => {
        p.ed25519 = async () => false;
      },
    });
    expect(await plugin.canSign).toBe(false);
    await plugin.settled();
    expect(notices.filter((n) => n === t().pluginNoEd25519)).toHaveLength(1);
    const data = (plugin as unknown as { data: unknown }).data;
    plugin.unload();
    loadedPlugins.splice(loadedPlugins.indexOf(plugin), 1);
    notices.length = 0;
    const again = await loaded({
      app,
      data,
      before: (p) => {
        p.ed25519 = async () => false;
      },
    });
    await again.plugin.settled();
    expect(notices).not.toContain(t().pluginNoEd25519);
  });

  test("Ed25519 there: nothing said", async () => {
    const { plugin } = await loaded();
    expect(await plugin.canSign).toBe(true);
    expect(notices).not.toContain(t().pluginNoEd25519);
  });
});

describe("Obsidian's editor in Write (phase 17, decisions 4, 5, 8)", () => {
  const writing = (view: DocumentLeafView | undefined) => ({
    obsidian: view?.containerEl.querySelector(
      ".markdown-source-view .cm-editor",
    ),
    editors: view?.containerEl.querySelectorAll(".cm-editor").length,
  });

  test("a linked note is written in Obsidian's editor, and what is typed reaches the note", async () => {
    const { rest, app, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [view] = views(app);

    expect(writing(view).obsidian).toBeTruthy();
    expect(writing(view).editors).toBe(1);
    typeIn(view, "typed in Obsidian's editor");
    await rest();
    expect(
      (() =>
        app.vault
          .text(notes(app)[0]?.path ?? "")
          ?.includes("typed in Obsidian's editor") ?? false)(),
    ).toBe(true);
  });

  test("the page's editor, when chosen in the settings (kept in data.json)", async () => {
    const { app, plugin, paste } = await loaded();
    const tab = (
      plugin as unknown as {
        settingTabs: { display(): void; containerEl: HTMLElement }[];
      }
    ).settingTabs[0];
    tab?.display();
    const select = tab?.containerEl.querySelector("select");
    if (!select) throw new Error("no editor setting");
    expect(select.value).toBe("obsidian");
    select.value = "page";
    select.dispatchEvent(new Event("change"));
    await plugin.settled();

    await paste((await newLinks("doc")).edit);

    expect(writing(views(app)[0]).obsidian).toBeFalsy();
    expect(writing(views(app)[0]).editors).toBe(1);
    expect(
      JSON.stringify((plugin as unknown as { data: unknown }).data),
    ).toContain('"editor":"page"');
  });

  test("Obsidian changed: the page's editor, and the view says so", async () => {
    const app = new FakeApp();
    app.embedRegistry = undefined;
    const { paste } = await loaded({ app });
    await paste((await newLinks("doc")).edit);
    const [view] = views(app);

    expect(writing(view).obsidian).toBeFalsy();
    expect(writing(view).editors).toBe(1);
    expect(view?.contentEl.textContent).toContain(t().pluginEditorUnavailable);
  });

  test("Obsidian's options read again (a plugin enabled after the view opened); undone when disabled", async () => {
    const app = new FakeApp();
    const original = app.workspace.updateOptions;
    const { plugin, paste } = await loaded({ app });
    await paste((await newLinks("doc")).edit);
    const obsidian = views(app)[0]?.containerEl.querySelector(
      ".markdown-source-view",
    );
    const editor = [
      ...(
        plugin as unknown as {
          children: { editorEl?: Element; options: number }[];
        }
      ).children,
    ].find((child) => child.editorEl === obsidian);

    app.workspace.updateOptions();

    expect(app.workspace.optionsUpdated).toBe(1);
    expect(editor?.options).toBe(1);
    plugin.unload();
    loadedPlugins.splice(loadedPlugins.indexOf(plugin), 1);
    expect(app.workspace.updateOptions).toBe(original);
  });
});

describe("moving a section (phase 17, decision 7)", () => {
  const editorText = (view: DocumentLeafView | undefined) => {
    const element = view?.containerEl.querySelector<HTMLElement>(".cm-editor");
    return element && EditorView.findFromDOM(element);
  };

  test("two commands of Obsidian's move the section the caret is in, in the document and the note", async () => {
    const { rest, app, command, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [view] = views(app);
    const cm = editorText(view);
    if (!cm) throw new Error("no editor");
    cm.dispatch({ changes: { from: 0, insert: "# A\na\n# B\nb\n" } });
    cm.dispatch({ selection: { anchor: "# A\na\n# B\n".length } });

    expect(command("move-section-up").checkCallback?.(true)).toBe(true);
    command("move-section-up").checkCallback?.(false);

    expect(cm.state.doc.toString()).toBe("# B\nb\n# A\na\n");
    await rest();
    expect(
      (() =>
        app.vault
          .text(notes(app)[0]?.path ?? "")
          ?.endsWith("# B\nb\n# A\na\n") ?? false)(),
    ).toBe(true);
    command("move-section-down").checkCallback?.(false);
    expect(cm.state.doc.toString()).toBe("# A\na\n# B\nb\n");
  });

  test("not offered outside a linked note's view, nor to a reader", async () => {
    const { app, command, paste } = await loaded();
    expect(command("move-section-up").checkCallback?.(true)).toBe(false);
    await paste((await newLinks("doc")).read);
    expect(views(app)).toHaveLength(1);
    expect(command("move-section-up").checkCallback?.(true)).toBe(false);
  });
});

describe("a change from outside (decision 4; analysis 14e)", () => {
  /** A linked note with "hello" in it, exported; the file then changed
   * from outside, its text `changed`. */
  async function changedOutside(role: "edit" | "read" = "edit") {
    const setUp = await loaded();
    const { app, paste, server } = setUp;
    const links = await newLinks("doc");
    const writer = await openLink(links.edit, {
      socketFactory: () => server.connect(),
    });
    writer.content.getText("content").insert(0, "hello");
    writer.content.commit();
    await writer.whenPublished();
    await paste(role === "edit" ? links.edit : links.read);
    const path = notes(app)[0]?.path ?? "";
    await eventually(() => notes(app)[0]?.content === "hello");
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    const exported = app.vault.text(path) ?? "";
    await app.vault.modify(file, exported.replace(/hello$/, "hello, world"));
    const view = views(app)[0];
    await eventually(
      () =>
        app.vault.getMarkdownFiles().length === 2 &&
        app.vault.text(path) === exported,
    );
    const copy = app.vault
      .getMarkdownFiles()
      .find((f: TFile) => f.path !== path) as TFile;
    return { ...setUp, writer, links, path, view, copy };
  }

  test("on another device's export, ahead of operations that leave the text as it was: kept once they arrive, the note the export again", async () => {
    const { rest, app, paste, server } = await loaded();
    const links = await newLinks("doc");
    const writer = await openLink(links.edit, {
      socketFactory: () => server.connect(),
    });
    const text = writer.content.getText("content");
    text.insert(0, "hello");
    writer.content.commit();
    await writer.whenPublished();
    await paste(links.edit);
    const path = notes(app)[0]?.path ?? "";
    await rest();
    expect(notes(app)[0]?.content).toBe("hello");
    const exported = app.vault.text(path) ?? "";

    // Typed and deleted on the other device, in one change: the same
    // text, a later version, its operations held back on their way here.
    server.pauseDelivery();
    text.insert(5, "!");
    text.delete(5, 1);
    writer.content.commit();
    await writer.whenPublished();
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    const looked = vi.spyOn(app.vault, "process");
    await app.vault.modify(
      file,
      writeHeader("hello, world", {
        document: "doc",
        version: formatVersion(writer.content.frontiers()),
      }),
    );
    // The export looked, and left it for a version not here yet (ME6).
    await rest();
    expect(looked.mock.calls.length > 0).toBe(true);
    server.resumeDelivery();

    await rest();
    expect(app.vault.getMarkdownFiles().length).toBe(2);
    const copy = app.vault
      .getMarkdownFiles()
      .find((f: TFile) => f.path !== path) as TFile;
    expect(app.vault.text(copy.path)).toBe("hello, world");
    await rest();
    expect(notes(app)[0]?.content).toBe("hello");
    expect(app.vault.text(path)).not.toBe(exported);
    writer.close();
  });

  test("is kept in a copy beside the note, without its link; the note is the export again, and the view says where", async () => {
    const { app, path, view, copy, writer } = await changedOutside();

    expect(copy.path.startsWith(`${path.replace(/\.md$/, "")} (`)).toBe(true);
    expect(app.vault.text(copy.path)).toBe("hello, world");
    expect(view?.containerEl.textContent).toContain(
      t().pluginModifiedOutside(copy.basename),
    );
    writer.close();
  });

  test("resumed, it enters the document, reaches the others, and the button goes", async () => {
    const { rest, app, path, view, writer } = await changedOutside();
    const resume = view?.containerEl.querySelector<HTMLButtonElement>(
      ".collab-link-resume",
    );
    expect(resume?.textContent).toBe(t().pluginResume);

    resume?.click();

    await rest();
    expect(notes(app)[0]?.content).toBe("hello, world");
    await rest();
    expect(writer.content.getText("content").toString()).toBe("hello, world");
    expect(view?.containerEl.querySelector(".collab-link-resume")).toBeNull();
    expect(app.vault.text(path)).toContain("hello, world");
    writer.close();
  });

  test("for a reader, a copy and no resuming (ME5)", async () => {
    const { view, copy, writer } = await changedOutside("read");
    expect(copy).toBeDefined();
    expect(view?.containerEl.querySelector(".collab-link-resume")).toBeNull();
    writer.close();
  });
});

describe("Share this note", () => {
  async function withNote(text = "---\ntags: [x]\n---\n# Plan\n\nDraft.\n") {
    const loadedPlugin = await loaded();
    const { app, plugin } = loadedPlugin;
    const tab = (
      plugin as unknown as {
        settingTabs: { display(): void; containerEl: HTMLElement }[];
      }
    ).settingTabs[0];
    tab?.display();
    const fields = tab?.containerEl.querySelectorAll("input") ?? [];
    const set = (at: number, value: string) => {
      const input = fields[at];
      if (!input) throw new Error("no such setting");
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    await app.vault.create("Plan.md", text);
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: "Plan.md" } });
    return { ...loadedPlugin, set, leaf };
  }

  test("asks first, saying that properties are shared and the note changes status (decisions 9, 11)", async () => {
    const { app, share, set } = await withNote();
    set(0, "https://collab.test");

    const said = await share("cancel");

    expect(said).toContain(t().pluginShareProperties);
    expect(said).toContain(t().pluginShareChange);
    expect(app.vault.text("Plan.md")).toBe(
      "---\ntags: [x]\n---\n# Plan\n\nDraft.\n",
    );
  });

  test("shared: a linked note, open in the view; the server has its text, header included; the link kept", async () => {
    const { app, server, share, set } = await withNote();
    set(0, "https://collab.test/");

    await share();

    const { header, content } = readHeader(app.vault.text("Plan.md") ?? "");
    expect(content).toBe("---\ntags: [x]\n---\n# Plan\n\nDraft.\n");
    expect(header?.document).toBe("shared-1");
    expect(app.workspace.activeLeaf?.view?.getViewType()).toBe(DOCUMENT_VIEW);
    const kept = [...app.secretStorage.values.values()].find((v) =>
      v.includes("doc=shared-1"),
    );
    expect(kept?.startsWith("https://collab.test/?doc=shared-1#")).toBe(true);
    const reader = await openLink(kept ?? "", {
      socketFactory: () => server.connect(),
    });
    expect(reader.content.getText("content").toString()).toBe(content);
    reader.close();
  });

  test("with a name and password set, sends them with the creation; the password never in data.json", async () => {
    const { plugin, share, set, created } = await withNote();
    set(0, "https://collab.test");
    set(1, "alice");
    set(2, "s3cret-pass");
    await plugin.settled();

    await share();

    expect(created[0]).toContain('"Authorization":"Basic ');
    expect(
      JSON.stringify((plugin as unknown as { data: unknown }).data),
    ).not.toContain("s3cret-pass");
  });

  test("without a server set, or one without TLS, says so and shares nothing", async () => {
    const { app, share, set } = await withNote();
    await share();
    set(0, "http://collab.example.org");
    await share();

    expect(notices).toEqual([t().pluginNoServer, t().pluginBadServer]);
    expect(readHeader(app.vault.text("Plan.md") ?? "").header).toBeUndefined();
  });

  test("a name or password refused says so, and leaves the note as it is", async () => {
    const { app, plugin, share, set } = await withNote();
    set(0, "https://collab.test");
    plugin.request = async () =>
      ({
        status: 401,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      }) as never;

    await share();

    expect(notices).toEqual([t().pluginShareDenied]);
    expect(readHeader(app.vault.text("Plan.md") ?? "").header).toBeUndefined();
  });

  test("a linked note is not shared again", async () => {
    const { command, share, set } = await withNote();
    set(0, "https://collab.test");
    await share();
    expect(command("share-note").checkCallback?.(true)).toBe(false);
  });
});

// Decision 7: diagrams and Obsidian's own rendering, in Obsidian's reading
// view beside the plugin's — reading only: typing there would be a change
// from outside (decision 4).
describe("Obsidian's preview alongside (decision 7)", () => {
  const previews = (app: FakeApp) =>
    app.workspace.leaves.filter(
      (leaf: WorkspaceLeaf) => leaf.view?.getViewType() === "markdown",
    );

  test("opens the note's file beside the view, in Obsidian's reading view", async () => {
    const { app, command, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [view] = views(app);

    expect(command("obsidian-preview").checkCallback?.(false)).toBe(true);
    await vi.waitFor(() => expect(previews(app)).toHaveLength(1));

    const [leaf] = previews(app);
    expect(leaf?.openedAs).toBe("split vertical");
    expect(leaf?.getViewState().state).toMatchObject({
      file: view?.file?.path,
      mode: "preview",
    });
    // The plugin's view is still the note's live view.
    expect(views(app)).toHaveLength(1);
  });

  test("asked again, it shows the pane already open, not a second one", async () => {
    const { app, command, paste } = await loaded();
    await paste((await newLinks("doc")).edit);
    const [view] = views(app);
    command("obsidian-preview").checkCallback?.(false);
    await vi.waitFor(() => expect(previews(app)).toHaveLength(1));

    app.workspace.setActiveLeaf(view?.leaf as unknown as WorkspaceLeaf);
    command("obsidian-preview").checkCallback?.(false);
    await vi.waitFor(() =>
      expect(app.workspace.activeLeaf).toBe(previews(app)[0]),
    );
    expect(previews(app)).toHaveLength(1);
  });

  test("is offered only from the plugin's view", async () => {
    const { app, command } = await loaded();
    const plain = await app.vault.create("plain.md", "# Plain\n");
    await app.workspace
      .getLeaf("tab")
      .setViewState({ type: "markdown", state: { file: plain.path } });

    expect(command("obsidian-preview").checkCallback?.(true)).toBe(false);
  });
});

describe("Obsidian's outline and links lead the view (phase 16, decisions 9, 13)", () => {
  const TEXT = "# One\n\nSome text.\n\n## Two\n\nMore text.\n\n## Three\n";

  /** A linked note with headings, exported; its view, its editor. */
  async function withHeadings() {
    const setup = await loaded();
    await setup.paste((await newLinks("doc")).edit);
    const view = views(setup.app)[0] as DocumentLeafView;
    typeIn(view, TEXT);
    // Named after its title once the typing pauses: its path then.
    await eventually(
      () =>
        view.file?.basename === "One" &&
        (setup.app.vault.text(view.file.path) ?? "").includes("## Three"),
    );
    const path = view.file?.path as string;
    return { ...setup, view, path };
  }
  const editorOf = (view: DocumentLeafView | undefined) => {
    const element = view?.containerEl.querySelector<HTMLElement>(".cm-editor");
    const editor = element && EditorView.findFromDOM(element);
    if (!editor) throw new Error("no editor");
    return editor;
  };
  const caretAt = (view: DocumentLeafView | undefined, heading: string) => {
    const editor = editorOf(view);
    return (
      editor.state.selection.main.head ===
      editor.state.doc.toString().indexOf(heading)
    );
  };
  /** The line of `heading` in the note's file, as the outline gives it. */
  const fileLine = (app: FakeApp, path: string, heading: string) =>
    (app.vault.text(path) ?? "").split("\n").indexOf(heading);

  test("a heading clicked in the outline: the view's caret on it, in the same tab", async () => {
    const { app, view, path } = await withHeadings();
    await view.leaf.setViewState(
      { type: "markdown", state: { file: path } },
      { line: fileLine(app, path, "## Two") },
    );
    expect(views(app)).toEqual([view]);
    expect(caretAt(view, "## Two")).toBe(true);
  });

  test("a link to a heading, the note closed: opened, then the caret on it", async () => {
    const { rest, app, view, path } = await withHeadings();
    await view.leaf.detach();
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState(
      { type: "markdown", state: { file: path } },
      { subpath: "#Three" },
    );
    const opened = leaf.view as unknown as DocumentLeafView;
    await opened.ready();
    await rest();
    expect(caretAt(opened, "## Three")).toBe(true);
  });

  test("the export late: the heading found by its text, not its line", async () => {
    const { app, view, path } = await withHeadings();
    const line = fileLine(app, path, "## Two");
    // Lines typed above it, not exported yet.
    const editor = editorOf(view);
    editor.dispatch({ changes: { from: 0, insert: "New\n\nlines\n\n" } });
    await view.leaf.setViewState(
      { type: "markdown", state: { file: path } },
      { line },
    );
    expect(caretAt(view, "## Two")).toBe(true);
  });

  test("two asked before the view is open: the last one", async () => {
    const { rest, app, view, path } = await withHeadings();
    await view.leaf.detach();
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState(
      { type: "markdown", state: { file: path } },
      { subpath: "#Two" },
    );
    const opened = leaf.view as unknown as DocumentLeafView;
    opened.setEphemeralState({ subpath: "#Three" });
    await opened.ready();
    await rest();
    expect(caretAt(opened, "## Three")).toBe(true);
  });

  test("closed with a heading still asked: nothing, anywhere", async () => {
    const { app, view, path } = await withHeadings();
    await view.leaf.detach();
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState(
      { type: "markdown", state: { file: path } },
      { subpath: "#Three" },
    );
    const opened = leaf.view as unknown as DocumentLeafView;
    await leaf.detach();
    await opened.ready();
    // Opened again without asking: the caret where an editor puts it.
    const again = app.workspace.getLeaf("tab");
    await again.setViewState({ type: "markdown", state: { file: path } });
    const view2 = again.view as unknown as DocumentLeafView;
    await view2.ready();
    expect(caretAt(view2, "## Three")).toBe(false);
  });

  test("a link to a heading of a note open in another tab: that tab, its caret on it (decision 13)", async () => {
    const { app, view, path } = await withHeadings();
    const other = app.workspace.getLeaf("tab");
    app.workspace.activeLeaf = other;
    await other.setViewState(
      { type: "markdown", state: { file: path } },
      { subpath: "#Three" },
    );
    await (other.view as unknown as DocumentLeafView).ready();
    expect(caretAt(view, "## Three")).toBe(true);
    expect(app.workspace.activeLeaf).toBe(view.leaf);
  });

  test("only the focus, to a tab that doesn't hold the note: it stays where it is", async () => {
    const { app, path } = await withHeadings();
    const other = app.workspace.getLeaf("tab");
    app.workspace.activeLeaf = other;
    await other.setViewState(
      { type: "markdown", state: { file: path } },
      { focus: true },
    );
    await (other.view as unknown as DocumentLeafView).ready();
    expect(app.workspace.activeLeaf).toBe(other);
  });

  test("the focus asked: the editor has it", async () => {
    const { view } = await withHeadings();
    (document.activeElement as HTMLElement | null)?.blur();
    view.setEphemeralState({ focus: true });
    expect(editorOf(view).hasFocus).toBe(true);
  });

  // Analysis 16.0, interleavings 4 to 8, in a controlled order: what
  // Obsidian asks (a heading, the focus), the opening's end (the
  // document held back until the scenario lets it through, then waited
  // for), the view closed — each a choice drawn by Hegel. Once all is settled: an open
  // view's caret is on the last heading asked; nothing throws.
  test("whatever the order of what is asked, the opening's end and closing: the last heading asked", async () => {
    const setup = await withHeadings();
    const { app, plugin, path } = setup;
    await setup.view.leaf.detach();
    const original = plugin.openDocument;
    // The opening held back until the scenario lets it through —
    // before or after the opening reaches it.
    let through = false;
    let waiting: (() => void)[] = [];
    const release = () => {
      through = true;
      for (const go of waiting.splice(0)) go();
    };
    plugin.openDocument = async (options) => {
      if (!through) await new Promise<void>((go) => waiting.push(go));
      return original(options);
    };
    const HEADINGS = ["One", "Two", "Three"] as const;
    await hegel.testAsync(
      async (tc) => {
        through = false;
        waiting = [];
        const leaf = app.workspace.getLeaf("tab");
        const first = tc.draw(gs.sampledFrom([undefined, ...HEADINGS]));
        let last: string | undefined = first;
        await leaf.setViewState(
          { type: "markdown", state: { file: path } },
          first ? { subpath: `#${first}` } : undefined,
        );
        const view = leaf.view as unknown as DocumentLeafView;
        let released = false;
        let closed = false;
        // Whatever ends the case — a check failed, or Hegel stopping it
        // at a draw —, the view is closed: every case starts with the
        // document free (one live view).
        try {
          const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
          const ask = () => {
            const heading = tc.draw(gs.sampledFrom(HEADINGS));
            const mark = `${heading === "One" ? "#" : "##"} ${heading}`;
            view.setEphemeralState(
              tc.draw(gs.booleans())
                ? { subpath: `#${heading}` }
                : { line: fileLine(app, path, mark) },
            );
            last = heading;
          };
          for (let i = 0; i < steps && !closed; i++) {
            switch (
              tc.draw(
                gs.sampledFrom([
                  "ask",
                  "askTwice",
                  "focus",
                  "release",
                  "close",
                ]),
              )
            ) {
              case "ask":
                ask();
                break;
              // Two headings asked in a row, as one gesture: which one wins
              // is decided there, rare when drawn one by one.
              case "askTwice":
                ask();
                ask();
                break;
              case "focus":
                view.setEphemeralState({ focus: true });
                break;
              // The opening ends now: nothing left running out of the
              // scenario's hands (AGENTS.md §1.6).
              case "release":
                released = true;
                release();
                await view.ready();
                break;
              case "close":
                closed = true;
                if (!released) release();
                await leaf.detach();
                await view.ready();
                break;
            }
          }
          if (!released && !closed) release();
          await view.ready();
          const heading = last;
          if (!closed && heading) {
            const mark = `${heading === "One" ? "#" : "##"} ${heading}`;
            if (!caretAt(view, mark)) {
              throw new Error(
                `asked last ${mark}, caret at ${editorOf(view).state.selection.main.head}`,
              );
            }
          }
        } finally {
          if (!released) release();
          if (!closed) await leaf.detach();
          await view.ready();
        }
      },
      { testCases: 50 },
    );
  }, 120_000);
});

describe("links between notes (phase 19)", () => {
  /** A document on the server holding `text`; its edit link. */
  async function documentWith(id: string, text: string, server: FakeServer) {
    const links = await newLinks(id);
    const writer = await openLink(links.edit, {
      socketFactory: () => server.connect(),
    });
    writer.content.getText("content").insert(0, text);
    writer.content.commit();
    await writer.whenPublished();
    return { links, writer };
  }

  /** The plugin, with B linked (« Collab Link/B.md ») and the server set. */
  async function withB() {
    const setUp = await loaded();
    const { app, plugin, paste, server } = setUp;
    (
      plugin as unknown as {
        storage: { setSetting(n: string, v: unknown): void };
      }
    ).storage.setSetting("server", ORIGIN);
    const b = await documentWith("b", "# B\n", server);
    await paste(b.links.edit);
    const pathB = notes(app).find((n) => n.header?.document === "b")?.path;
    if (!pathB) throw new Error("B not linked");
    return { ...setUp, b, pathB };
  }

  test("sharing a note: its [[B]] to a linked note becomes B's address, to itself [[#…]]; another note's stays (decisions 1, 2)", async () => {
    const { app, server, share, b } = await withB();
    await app.vault.create(
      "Plan.md",
      "Voir [[B]], [[Plan#Haut|en haut]] et [[Brouillon]].\n",
    );
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: "Plan.md" } });

    await share();

    const kept = [...app.secretStorage.values.values()].find((v) =>
      v.includes("doc=shared-1"),
    );
    const reader = await openLink(kept ?? "", {
      socketFactory: () => server.connect(),
    });
    expect(reader.content.getText("content").toString()).toBe(
      `Voir [B](${ORIGIN}/?doc=b), [[#Haut|en haut]] et [[Brouillon]].\n`,
    );
    reader.close();
    b.writer.close();
  });

  test("unlinking: an address of a note of this vault becomes its name; a note unlinked before is found too (decisions 1, 9)", async () => {
    const { rest, app, server, paste, command, b } = await withB();
    const a = await documentWith(
      "a",
      `# A\n\nVers [B#Partie](${ORIGIN}/?doc=b#h=Partie), [là](${ORIGIN}/?doc=b) et [ailleurs](${ORIGIN}/?doc=z).\n`,
      server,
    );
    await paste(a.links.edit);
    const pathA =
      notes(app).find((n) => n.header?.document === "a")?.path ?? "";
    const viewA = views(app).find((v) => v.file?.path === pathA);
    app.workspace.setActiveLeaf(viewA?.leaf as unknown as WorkspaceLeaf);

    command("unlink-note").checkCallback?.(false);
    await rest();
    expect(!views(app).some((v) => v.file?.path === pathA)).toBe(true);

    expect(app.vault.text(pathA)).toBe(
      `# A\n\nVers [[B#Partie]], [[B|là]] et [ailleurs](${ORIGIN}/?doc=z).\n`,
    );
    a.writer.close();
    b.writer.close();
  });

  test("typed in Obsidian's editor of a linked note, a [[B]] accepted becomes B's address (decision 3)", async () => {
    const { rest, app, server, paste, b } = await withB();
    const a = await documentWith("a", "# A\n\n", server);
    await paste(a.links.edit);
    const viewA = views(app).find((v) => v.file?.path.endsWith("A.md"));
    const element = viewA?.containerEl.querySelector<HTMLElement>(
      ".markdown-source-view .cm-editor",
    );
    const editor = element && EditorView.findFromDOM(element);
    if (!editor) throw new Error("no Obsidian editor");
    const end = editor.state.doc.length;
    // A suggestion accepted: the whole link, the caret after it.
    editor.dispatch({
      changes: { from: end, insert: "[[B]]" },
      selection: { anchor: end + 5 },
      userEvent: "input",
    });

    await rest();
    expect(
      a.writer.content.getText("content").toString() ===
        `# A\n\n[B](${ORIGIN}/?doc=b)`,
    ).toBe(true);
    a.writer.close();
    b.writer.close();
  });

  /** Obsidian's `window.open`, as the plugin finds it at loading: what
   * reaches the system's browser. */
  function browser() {
    const sent: string[] = [];
    const original = window.open;
    window.open = ((url?: string | URL) => {
      sent.push(String(url));
      return null;
    }) as typeof window.open;
    onTestFinished(() => {
      window.open = original;
    });
    return sent;
  }

  test("an address of its server clicked (Obsidian opens it by window.open): the linked note, at its heading; nothing to the browser (decision 6)", async () => {
    const sent = browser();
    const { app, plugin, pathB, b } = await withB();
    await app.vault.create("Ailleurs.md", "# Ailleurs\n");
    await app.workspace
      .getLeaf("tab")
      .setViewState({ type: "markdown", state: { file: "Ailleurs.md" } });
    const asked = vi.spyOn(DocumentLeafView.prototype, "setEphemeralState");

    window.open(`${ORIGIN}/?doc=b#h=Partie%20un`);
    await plugin.settled();

    expect(sent).toEqual([]);
    expect(app.workspace.activeLeaf?.view?.getViewType()).toBe(DOCUMENT_VIEW);
    expect(app.workspace.getActiveFile()?.path).toBe(pathB);
    expect(asked).toHaveBeenCalledWith(
      expect.objectContaining({ subpath: "#Partie un" }),
    );
    b.writer.close();
  });

  test("an address of a note unlinked here: that note; of no note nor list here: said, with a way to the browser; of another server, or a full link: the browser (decisions 6, 9)", async () => {
    const sent = browser();
    const { rest, app, plugin, command, pathB, b } = await withB();
    const viewB = views(app).find((v) => v.file?.path === pathB);
    app.workspace.setActiveLeaf(viewB?.leaf as unknown as WorkspaceLeaf);
    command("unlink-note").checkCallback?.(false);
    await rest();
    expect(views(app).length).toBe(0);
    await app.vault.create("Ailleurs.md", "# Ailleurs\n");
    await app.workspace
      .getLeaf("tab")
      .setViewState({ type: "markdown", state: { file: "Ailleurs.md" } });

    window.open(`${ORIGIN}/?doc=b`);
    await plugin.settled();
    expect(app.workspace.getActiveFile()?.path).toBe(pathB);
    expect(app.workspace.activeLeaf?.view?.getViewType()).toBe("markdown");

    window.open(`${ORIGIN}/?doc=z`);
    await plugin.settled();
    expect(sent).toEqual([]);
    expect(notices.at(-1)).toContain(t().pluginAddressUnknown);
    noticeFragments.at(-1)?.querySelector("button")?.click();
    expect(sent).toEqual([`${ORIGIN}/?doc=z`]);

    window.open("https://ailleurs.test/?doc=b");
    window.open(`${ORIGIN}/?doc=b#k=K&r=edit.S`);
    expect(sent.slice(1)).toEqual([
      "https://ailleurs.test/?doc=b",
      `${ORIGIN}/?doc=b#k=K&r=edit.S`,
    ]);
    b.writer.close();
  });

  test("the command: the [[B]] another wrote in this note become B's address, in its document", async () => {
    const { rest, app, server, paste, command, b } = await withB();
    const a = await documentWith("a", "# A\n\nVers [[B]].\n", server);
    await paste(a.links.edit);
    const viewA = views(app).find((v) => v.file?.path.endsWith("A.md"));
    app.workspace.setActiveLeaf(viewA?.leaf as unknown as WorkspaceLeaf);

    command("convert-links").checkCallback?.(false);

    await rest();
    expect(
      a.writer.content.getText("content").toString() ===
        `# A\n\nVers [B](${ORIGIN}/?doc=b).\n`,
    ).toBe(true);
    expect(notices.at(-1)).toBe(t().pluginLinksConverted(1));
    a.writer.close();
    b.writer.close();
  });

  test("a note renamed, Obsidian rewriting the links to it: no copy, the rewrite in the document (decision 10)", async () => {
    const { rest, app, server, paste, b } = await withB();
    await app.vault.create("C.md", "# C\n");
    const a = await documentWith("a", "# A\n\nVers [[C]].\n", server);
    await paste(a.links.edit);
    const pathA =
      notes(app).find((n) => n.header?.document === "a")?.path ?? "";
    await rest();
    expect(
      notes(app).find((n) => n.path === pathA)?.content ===
        "# A\n\nVers [[C]].\n",
    ).toBe(true);
    const before = app.vault.getMarkdownFiles().length;

    // As Obsidian does: the rename, then the files that link rewritten.
    await app.fileManager.renameFile(
      app.vault.getAbstractFileByPath("C.md") as TFile,
      "D.md",
    );
    const fileA = app.vault.getAbstractFileByPath(pathA) as TFile;
    await app.vault.process(fileA, (text: string) =>
      text.replace("[[C]]", "[[D]]"),
    );

    await rest();
    expect(
      a.writer.content.getText("content").toString() === "# A\n\nVers [[D]].\n",
    ).toBe(true);
    expect(app.vault.getMarkdownFiles().length).toBe(before);
    a.writer.close();
    b.writer.close();
  });

  test("sharing a note: the [[…]] to it in a linked note open here become its address; one closed, counted (decision 11)", async () => {
    const { rest, app, server, paste, share, b } = await withB();
    const a = await documentWith("a", "# A\n\nVers [[Plan]].\n", server);
    await paste(a.links.edit);
    await app.vault.create("Plan.md", "# Plan\n");
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "markdown", state: { file: "Plan.md" } });

    await share();

    await rest();
    expect(
      a.writer.content.getText("content").toString() ===
        `# A\n\nVers [Plan](${ORIGIN}/?doc=shared-1).\n`,
    ).toBe(true);
    expect(notices).toContain(t().pluginIncomingLinks(1, 0));
    a.writer.close();
    b.writer.close();
  });
});
