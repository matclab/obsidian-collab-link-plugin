// @vitest-environment jsdom
//
// A document opened in an element (docs/phase-14-plugin-obsidian.md,
// decision 2): the page mounts one in its body, the Obsidian plugin one per
// linked note, several in the same window. Each keeps to its element —
// its editor, its notices, its dialogs, its labels' ids.
import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  CloseCode,
  ConnectionRefused,
  createDocument,
  documentLinks,
  importKeyFromBase64Url,
  parseLinkFragment,
} from "../../lib/src/index.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { mayInsertImage } from "../editor/image-insertion.js";
import { currentLanguage, t } from "../i18n/index.js";
import { openLocalState } from "../storage/index.js";
import { FakeLocks } from "../storage/test-support/fake-locks.js";
import { VERSION } from "../version.js";
import {
  type DocumentTarget,
  type DocumentViewEnvironment,
  mountDocumentView,
} from "./document-view.js";
import { refusalMessage } from "./messages.js";
import { type OpenedDocument, openDocument } from "./open-document.js";

const ORIGIN = "https://collab.test";

/** A `Storage` in memory, with a name already chosen (no dialog). */
function memoryStorage(): Storage {
  const items = new Map<string, string>([
    ["obsidian-collab:pseudonym", "alice"],
  ]);
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

function environment(
  server: FakeServer,
  overrides: Partial<DocumentViewEnvironment> = {},
): DocumentViewEnvironment {
  return {
    reload: () => {},
    storage: memoryStorage(),
    indexedDB: undefined,
    lock: undefined,
    online: () => true,
    window: new EventTarget(),
    confirm: () => true,
    copy: async () => {},
    documentLinks,
    openDocument: (options) =>
      openDocument({ ...options, socketFactory: () => server.connect() }),
    ...overrides,
  };
}

/** A window that counts the listeners still added to it. */
class CountingTarget extends EventTarget {
  listening = 0;
  override addEventListener(
    ...args: Parameters<EventTarget["addEventListener"]>
  ): void {
    this.listening++;
    super.addEventListener(...args);
  }
  override removeEventListener(
    ...args: Parameters<EventTarget["removeEventListener"]>
  ): void {
    this.listening--;
    super.removeEventListener(...args);
  }
}

/** A new document's edit link, and what the view opens it with. */
async function newDocument(id: string) {
  const created = await createDocument(ORIGIN, async () =>
    Response.json({ document_id: id }),
  );
  const links = await documentLinks(
    `${ORIGIN}/`,
    id,
    created.keyMaterial,
    created.editSecret,
  );
  return {
    links,
    target: {
      apiBase: ORIGIN,
      documentId: id,
      link: parseLinkFragment(new URL(links.edit).hash),
      linkBase: () => `${ORIGIN}/`,
    },
  };
}

describe("a document view", () => {
  // Phase 18o.2, found at the real trial: signed in on this browser, the
  // first document opened takes the identity's name, without asking.
  test("signed in, no name chosen yet: the identity's, without a question", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const storage = memoryStorage();
    storage.removeItem("obsidian-collab:pseudonym");
    const opened = await newDocument("named");

    await mountDocumentView(root, environment(server, { storage }), {
      ...opened.target,
      signedInName: async () => "Grace Hopper",
    });

    expect(root.querySelector(".name-dialog")).toBeNull();
    expect(storage.getItem("obsidian-collab:pseudonym")).toBe("Grace Hopper");
  });

  // Found at the real trial (2026-10-20): a name chosen before the
  // sign-in stayed on the comments; signed in, the identity's is shown.
  test("signed in, a name chosen before: the identity's shown, the pseudonym kept", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const storage = memoryStorage();
    storage.setItem("obsidian-collab:pseudonym", "MCL");
    const opened = await newDocument("renamed");

    await mountDocumentView(root, environment(server, { storage }), {
      ...opened.target,
      signedInName: async () => "Ada Lovelace",
    });

    const field = root.querySelector<HTMLInputElement>(".pseudonym-input");
    expect(field?.value).toBe("Ada Lovelace");
    expect(field?.disabled).toBe(true);
    expect(storage.getItem("obsidian-collab:pseudonym")).toBe("MCL");
  });

  // The software's version (README, "Versions"), at the end of the
  // document menu: the page's, and the plugin's view's.
  test("its document menu ends with the software's version", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("versioned");
    await mountDocumentView(root, environment(new FakeServer()), opened.target);

    const body = root.querySelector(".document-dialog .dialog-body");
    const line = body?.lastElementChild;
    expect(line?.classList.contains("app-version")).toBe(true);
    expect(line?.textContent).toBe(t().appVersion(VERSION));
    expect(line?.textContent).toContain(VERSION);
    expect(line?.textContent).toContain("Collab Link");
  });

  // The writing help (phase 20d): from the document menu and from the
  // formatting toolbar, for an editor.
  test("the writing help opens from the document menu and the toolbar", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("helped");
    await mountDocumentView(root, environment(new FakeServer()), opened.target);
    const help = () =>
      root.querySelector<HTMLDialogElement>("dialog.help-dialog");
    expect(help()).toBeNull();
    root
      .querySelector<HTMLButtonElement>(".document-dialog .open-writing-help")
      ?.click();
    expect(help()?.open).toBe(true);
    help()?.querySelector<HTMLButtonElement>(".dialog-close")?.click();
    expect(help()?.open).toBe(false);
    root
      .querySelector<HTMLButtonElement>(
        '.format-toolbar button[aria-label="Writing help"]',
      )
      ?.click();
    expect(help()?.open).toBe(true);
    expect(root.querySelectorAll("dialog.help-dialog")).toHaveLength(1);
  });

  // Phase 37g, ADR-0064, AC1 – AC3.
  test("the first visit's banner, where the page asks it, opens the help; not otherwise (the plugin)", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("welcomed");
    await mountDocumentView(root, environment(new FakeServer()), {
      ...opened.target,
      welcome: true,
    });
    const banner = root.querySelector(".view-notices .welcome");
    expect(banner).not.toBeNull();
    banner?.querySelector<HTMLButtonElement>(".welcome-help")?.click();
    expect(
      root.querySelector<HTMLDialogElement>("dialog.help-dialog")?.open,
    ).toBe(true);

    // The plugin, the page's editor chosen in its settings: none either.
    const hosted = document.createElement("div");
    document.body.append(hosted);
    await mountDocumentView(
      hosted,
      environment(new FakeServer()),
      (await newDocument("hosted")).target,
    );
    expect(hosted.querySelector(".cm-editor")).not.toBeNull();
    expect(hosted.querySelector(".welcome")).toBeNull();
  });

  // Phase 37h, ADR-0064, AC6: after the banner, never with it; a
  // diagram's leads to Reading.
  test("the first hints once the banner is closed; the diagram's opens Reading", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("hinted");
    await mountDocumentView(root, environment(new FakeServer()), {
      ...opened.target,
      welcome: true,
    });
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    const cm = editor && EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no editor");
    cm.dispatch({
      changes: { from: 0, insert: "Words.\n```mermaid\nflowchart LR\n```" },
    });
    forceParsing(cm, cm.state.doc.length, 5000);
    const moveTo = (line: number) =>
      cm.dispatch({
        selection: { anchor: cm.state.doc.line(line).from },
        userEvent: "select",
      });
    const hint = () => root.querySelector(".first-hint");

    moveTo(3);
    expect(hint()).toBeNull();
    root.querySelector<HTMLButtonElement>(".welcome-done")?.click();
    moveTo(1);
    moveTo(3);
    expect(hint()?.textContent).toContain("drawn in Reading");
    hint()?.querySelectorAll<HTMLButtonElement>("button")[0]?.click();
    expect(root.querySelector<HTMLElement>(".preview")?.hidden).toBe(false);
  });

  test("a read link's document menu has no writing help", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("read-only");
    await mountDocumentView(root, environment(new FakeServer()), {
      ...opened.target,
      link: parseLinkFragment(new URL(opened.links.read).hash),
    });
    expect(root.querySelector(".open-writing-help")).toBeNull();
  });

  test("two views side by side in one window each keep to their element", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const roots = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    document.body.append(...roots);
    const documents = [await newDocument("one"), await newDocument("two")];

    for (const [at, root] of roots.entries()) {
      const opened = documents[at];
      if (!opened) throw new Error("no document");
      await mountDocumentView(root, environment(server), opened.target);
    }

    // Nothing added outside the two elements.
    expect(Array.from(document.body.children)).toEqual(roots);
    for (const [at, root] of roots.entries()) {
      expect(root.querySelectorAll(".cm-editor")).toHaveLength(1);
      // Its language, said on its element (not the host's).
      expect(root.lang).toBe(currentLanguage());
      expect(root.querySelectorAll(".share-dialog")).toHaveLength(1);
      expect(root.querySelectorAll(".document-dialog")).toHaveLength(1);
      // Each view's share panel, its own document's links.
      expect(
        root.querySelector<HTMLInputElement>(".share-dialog input.share-edit")
          ?.value,
      ).toBe(documents[at]?.links.edit);
    }
    // A label names its own view's field.
    const ids = Array.from(document.querySelectorAll("[id]"), (e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of Array.from(document.querySelectorAll("label[for]"))) {
      const field = document.getElementById(label.getAttribute("for") ?? "");
      expect(field?.closest(".document-view")).toBe(
        label.closest(".document-view"),
      );
    }
  });

  test("a refusal is said in the view refused, not in the other", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const roots = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    document.body.append(...roots);
    const [open, refused] = [
      await newDocument("open"),
      await newDocument("refused"),
    ];
    if (!open || !refused) throw new Error("no document");

    await mountDocumentView(
      roots[0] as HTMLElement,
      environment(server),
      open.target,
    );
    await mountDocumentView(
      roots[1] as HTMLElement,
      environment(server, {
        openDocument: () =>
          Promise.reject(new ConnectionRefused(CloseCode.Revoked)),
      }),
      refused.target,
    );

    const message = refusalMessage(CloseCode.Revoked);
    expect(roots[1]?.textContent).toContain(message);
    expect(roots[0]?.textContent).not.toContain(message);
  });

  test("closed, a view leaves, disconnects and no longer listens to the window", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("closed");
    const window = new CountingTarget();
    let opened: OpenedDocument | undefined;

    const view = await mountDocumentView(
      root,
      environment(server, {
        window,
        openDocument: async (options) => {
          opened = await openDocument({
            ...options,
            socketFactory: () => server.connect(),
          });
          return opened;
        },
      }),
      target,
    );
    if (!opened) throw new Error("not opened");
    const closed = vi.spyOn(opened.connection, "close");
    const left = vi.spyOn(opened.presence, "leave");
    expect(window.listening).toBeGreaterThan(0);

    await view.close();

    expect(closed).toHaveBeenCalledOnce();
    expect(left).toHaveBeenCalledOnce();
    expect(window.listening).toBe(0);
  });

  // Phase 14, decision 26: the view's width, not the window's — a narrow
  // pane of Obsidian puts the annotations in a sheet.
  test("narrow by its own width, its annotations go in a sheet; closed, it measures nothing more", async () => {
    document.body.innerHTML = "";
    const observers: { observed: Element[]; resize(width: number): void }[] =
      [];
    class Observer {
      observed: Element[] = [];
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(element: Element) {
        this.observed.push(element);
      }
      unobserve() {}
      disconnect() {
        this.observed = [];
      }
      resize(width: number) {
        const entries = this.observed.map(
          (target) => ({ target, contentRect: { width } }) as never,
        );
        this.callback(entries, this as never);
      }
    }
    vi.stubGlobal("ResizeObserver", Observer);
    try {
      const root = document.createElement("div");
      document.body.append(root);
      const { target } = await newDocument("narrow");
      const view = await mountDocumentView(
        root,
        environment(new FakeServer()),
        target,
      );
      const observer = observers.find((o) => o.observed.includes(root));
      if (!observer) throw new Error("the view's element is not measured");
      const workspace = root.querySelector(".view-workspace");
      observer.resize(1440);
      expect(workspace?.classList.contains("margin-hidden")).toBe(false);
      observer.resize(600);
      expect(workspace?.classList.contains("margin-hidden")).toBe(true);

      await view.close();
      expect(observer.observed).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("closed while refused, it no longer listens to the window either", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("refused");
    const window = new CountingTarget();

    const view = await mountDocumentView(
      root,
      environment(new FakeServer(), {
        window,
        openDocument: () =>
          Promise.reject(new ConnectionRefused(CloseCode.Revoked)),
      }),
      target,
    );
    await view.close();

    expect(window.listening).toBe(0);
  });

  // The plugin closes a view while its process lives on (phase 14,
  // decision 17; analysis 14c, NE6): what was typed is in the local
  // record, and the lock is free for the next view.
  test("a link to a heading, `[t](#x)`, leads there from the editor and the preview (phase 19, decision 8)", async () => {
    document.body.innerHTML = "";
    // What jsdom lacks: the boxes CodeMirror measures once asked to scroll.
    const saved = {
      rects: Range.prototype.getClientRects,
      box: Range.prototype.getBoundingClientRect,
    };
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    onTestFinished(() => {
      Range.prototype.getClientRects = saved.rects;
      Range.prototype.getBoundingClientRect = saved.box;
    });
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("anchors");
    const view = await mountDocumentView(
      root,
      environment(new FakeServer()),
      opened.target,
    );
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    const cm = editor && EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no editor");
    const text = "# Un\n\n[vers deux](#deux)\n\n## Deux\n\nfin";
    cm.dispatch({ changes: { from: 0, insert: text } });
    forceParsing(cm, cm.state.doc.length, 5000);

    // Ctrl+click in the editor (jsdom has no layout: the position given).
    cm.posAtCoords = (() => text.indexOf("vers")) as typeof cm.posAtCoords;
    cm.contentDOM.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    );
    expect(cm.state.selection.main.head).toBe(text.indexOf("## Deux"));

    // A click in the preview, on a link of its rendering.
    cm.dispatch({ selection: { anchor: 0 } });
    const preview = root.querySelector<HTMLElement>(".preview");
    const link = document.createElement("a");
    link.setAttribute("href", "#Deux");
    preview?.append(link);
    link.click();
    expect(cm.state.selection.main.head).toBe(text.indexOf("## Deux"));
    await view.close();
  });

  test("a full link of this server pasted: the keyless address goes in, the link to « Mes documents », a notice offers it back (phase 19, decision 12)", async () => {
    document.body.innerHTML = "";
    // What jsdom lacks: the boxes CodeMirror measures once asked to scroll.
    const saved = {
      rects: Range.prototype.getClientRects,
      box: Range.prototype.getBoundingClientRect,
    };
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    onTestFinished(() => {
      Range.prototype.getClientRects = saved.rects;
      Range.prototype.getBoundingClientRect = saved.box;
    });
    const root = document.createElement("div");
    document.body.append(root);
    const opened = await newDocument("pasting");
    const given: string[] = [];
    const view = await mountDocumentView(root, environment(new FakeServer()), {
      ...opened.target,
      keyring: {
        opened: async () => {},
        title: async () => {},
        refused: async () => {},
        keep: async () => {},
        available: async () => true,
        isKept: async () => false,
        setKept: async () => {},
        again: async () => {},
        given: async (link) => void given.push(link),
        titleOf: (id) => (id === "other" ? "Plan" : undefined),
      },
    });
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    const cm = editor && EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no editor");
    const other = await newDocument("other");
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { getData: () => text },
      });
      cm.contentDOM.dispatchEvent(event);
    };
    paste(other.links.edit);
    // The notice, once the view knows whether a list keeps the link.
    await vi.waitFor(() =>
      expect(root.querySelector(".view-notices")?.textContent).toContain(
        t().pastedLinkConverted,
      ),
    );

    expect(cm.state.doc.toString()).toBe(`[Plan](${ORIGIN}/?doc=other)`);
    expect(view.content?.getText("content").toString()).toBe(
      `[Plan](${ORIGIN}/?doc=other)`,
    );
    expect(given).toEqual([other.links.edit]);
    const keep = Array.from(root.querySelectorAll(".view-notices button")).find(
      (button) => button.textContent === t().keepFullLink,
    );
    expect(root.querySelector(".view-notices")?.textContent).toContain(
      t().pastedLinkConverted,
    );
    (keep as HTMLButtonElement | undefined)?.click();
    expect(cm.state.doc.toString()).toBe(other.links.edit);
    // Done: the notice goes.
    expect(root.querySelector(".view-notices")?.textContent).not.toContain(
      t().pastedLinkConverted,
    );

    // Pasted twice, the notice acts on the latest; the first one's
    // address changed, the button said it could not.
    const keepButton = () =>
      Array.from(
        root.querySelectorAll<HTMLButtonElement>(".view-notices button"),
      ).find((button) => button.textContent === t().keepFullLink);
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "" } });
    paste(other.links.edit);
    await vi.waitFor(() => expect(keepButton()).toBeDefined());
    cm.dispatch({
      changes: { from: cm.state.doc.length, insert: " " },
      selection: { anchor: cm.state.doc.length + 1 },
    });
    paste(other.links.edit);
    const address = `[Plan](${ORIGIN}/?doc=other)`;
    await vi.waitFor(() =>
      expect(cm.state.doc.toString()).toBe(`${address} ${address}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelectorAll(".view-notices .notice-action")).toHaveLength(
      1,
    );
    keepButton()?.click();
    expect(cm.state.doc.toString()).toBe(`${address} ${other.links.edit}`);

    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "" } });
    paste(other.links.edit);
    await vi.waitFor(() => expect(keepButton()).toBeDefined());
    cm.dispatch({ changes: { from: 1, to: 2, insert: "X" } });
    keepButton()?.click();
    expect(root.querySelector(".view-notices")?.textContent).toContain(
      t().pastedLinkGone,
    );
    await view.close();
  });

  test("closed, what was just typed is kept on the device, and the lock let go", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("kept");
    const indexedDB = new IDBFactory();
    const lock = new FakeLocks();
    const local = { indexedDB, lock, localNamespace: "vault" };

    const view = await mountDocumentView(
      root,
      environment(server, local),
      target,
    );
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    const cm = editor && EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no editor");
    cm.dispatch({ changes: { from: 0, insert: "typed just before closing" } });
    // Its document, for the plugin's export.
    expect(view.content?.getText("content").toString()).toBe(
      "typed just before closing",
    );
    await view.close();

    const key = await importKeyFromBase64Url(target.link.key);
    const state = await openLocalState({
      documentId: target.documentId,
      role: target.link.role,
      namespace: "vault",
      key,
      indexedDB,
      lock,
    });
    if (state.kind !== "owner") throw new Error(`not the owner: ${state.kind}`);
    const content = new LoroDoc();
    for (const channel of state.record?.channels ?? []) {
      if (channel.channel === "content") content.import(channel.snapshot);
    }
    expect(content.getText("content").toString()).toBe(
      "typed just before closing",
    );
  });
});

// Analysis 18k: what the page trusts of its gateway, applied to the view
// once read — the document's signatures and the presence's given the
// keys and each newer list; a comment written with the attestation of the
// key that signed it, in its commit (AT2, ID-38); the trust closed with
// the view.
// The signing key in the document menu: its fingerprint to give who asks
// to check (ADR-0051), never the key of « Mes documents ».
describe("the signing key in the document menu", () => {
  const mounted = async (
    id: string,
    signer: () => Promise<unknown>,
    role: "edit" | "read" = "edit",
  ) => {
    const { formatShortFingerprint } = await import("../../lib/src/index.js");
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const { links, target } = await newDocument(id);
    const copied: string[] = [];
    const asked = { signer: 0 };
    const view = await mountDocumentView(
      root,
      environment(new FakeServer(), {
        copy: async (text) => {
          copied.push(text);
        },
      }),
      {
        ...target,
        link: parseLinkFragment(new URL(links[role]).hash),
        identity: {
          signer: async () => {
            asked.signer += 1;
            return (await signer()) as never;
          },
          accountSigner: async () => undefined,
          fingerprints: async () => [],
          subscribe: async () => () => {},
          subscribeKey: async () => () => {},
          replaceRefused: async () => "none" as const,
          registrable: async () => false,
        },
      },
    );
    const section = () => root.querySelector(".document-dialog .signing-key");
    const openMenu = () =>
      root.querySelector<HTMLButtonElement>(".document-button")?.click();
    return { view, section, openMenu, copied, asked, formatShortFingerprint };
  };

  test("without a gateway: the menu shows its fingerprint, to copy", async () => {
    const { generateIdentityKey, signerOf } = await import(
      "../../lib/src/index.js"
    );
    const signer = await signerOf(await generateIdentityKey());
    const s = await mounted("signing-key", async () => signer);
    s.openMenu();
    const short = s.formatShortFingerprint(signer.fingerprint);
    await vi.waitFor(() => expect(s.section()?.textContent).toContain(short));
    expect(s.section()?.textContent).toContain(t().signingKeyTitle);
    expect(s.section()?.textContent).toContain(t().signingKeyNotKeyring);
    s.section()?.querySelector<HTMLButtonElement>(".signing-key-copy")?.click();
    await vi.waitFor(() => expect(s.copied).toEqual([short]));
    await s.view.close();
  });

  test("no key to sign with: nothing said", async () => {
    const s = await mounted("no-signing-key", async () => undefined);
    s.openMenu();
    await vi.waitFor(() => expect(s.asked.signer).toBeGreaterThan(0));
    await Promise.resolve();
    expect(s.section()?.textContent ?? "").toBe("");
    await s.view.close();
  });

  // A read link signs nothing; its menu draws no key.
  test("a read link: no signing key, none drawn", async () => {
    const s = await mounted(
      "read-signing-key",
      async () => {
        throw new Error("drawn");
      },
      "read",
    );
    s.openMenu();
    expect(s.section()).toBeNull();
    expect(s.asked.signer).toBe(0);
    await s.view.close();
  });
});

describe("a view with a gateway that attests", () => {
  test("the keys and the list reach the indexes; a comment carries its key's attestation", async () => {
    const { ATTESTATIONS, SignatureIndex, generateIdentityKey, signerOf } =
      await import("../../lib/src/index.js");
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("attested");
    const signer = await signerOf(await generateIdentityKey());
    const envelope = new Uint8Array([0xa3, 0x63, 0x6b, 0x65, 0x79]);
    const asked: string[] = [];
    let listeners = 0;
    let closed = false;
    const keys = new Set(["ab".repeat(32)]);
    const list = { issuedAt: 3, revoked: new Map<string, number>() };
    const setKeys = vi.spyOn(SignatureIndex.prototype, "setAttestationKeys");
    const setLists = vi.spyOn(SignatureIndex.prototype, "setRevocations");
    let opened: OpenedDocument | undefined;
    const view = await mountDocumentView(
      root,
      environment(server, {
        openDocument: async (options) => {
          opened = await openDocument({
            ...options,
            socketFactory: () => server.connect(),
          });
          return opened;
        },
      }),
      {
        ...target,
        identity: {
          signer: async () => signer,
          accountSigner: async () => undefined,
          fingerprints: async () => [],
          subscribe: async () => () => {},
          subscribeKey: async () => () => {},
          replaceRefused: async () => "none" as const,
          registrable: async () => false,
        },
        trust: Promise.resolve({
          attestationKeys: keys,
          revocations: {
            current: () => list,
            subscribe: () => {
              listeners += 1;
              return () => {
                listeners -= 1;
              };
            },
          },
          attestation: (publicKey: Uint8Array) => {
            asked.push(Buffer.from(publicKey).toString("hex"));
            return envelope;
          },
          refresh: async () => undefined,
          refusedKey: () => undefined,
          subscribe: () => () => {},
          setTimer: () => () => {},
          close: () => {
            closed = true;
          },
        }),
      },
    );
    // The document's index and the presence's, each told once.
    expect(setKeys.mock.calls.map(([k]) => k)).toEqual([keys, keys]);
    expect(setLists.mock.calls.map(([l]) => l)).toEqual([list, list]);
    expect(listeners).toBe(2);
    if (!opened) throw new Error("not opened");
    const { editor, panel } = opened.client;
    editor.view.dispatch({ changes: { from: 0, insert: "Bonjour" } });
    editor.view.dispatch({ selection: { anchor: 0, head: 7 } });
    expect(panel.create("comment", "?", "")).toBeUndefined();
    // Signed, then written with the signer's own attestation (AT2).
    const attestations = opened.annotationsDoc.getMap(ATTESTATIONS);
    await vi.waitFor(() => expect(attestations.size).toBe(1));
    expect(asked).toEqual([Buffer.from(signer.publicKey).toString("hex")]);
    expect([...attestations.values()]).toEqual([envelope]);
    await view.close();
    expect(closed).toBe(true);
    expect(listeners).toBe(0);
    setKeys.mockRestore();
    setLists.mockRestore();
  });
});

// Decision 20, AT3: the question before the first signed object, in the
// view — the comment waits for it; « Continuer sans » lets it through and
// is remembered; « S'identifier » opens the sign-in, and the comment is
// written once signed in, after the attestation was asked for.
describe("the question before the first signed object", () => {
  async function setUpView(
    options: {
      association?: DocumentTarget["association"];
      attestation?: import("../account/attestor.js").AttestorState;
      orgName?: string;
      openHome?: () => void;
    } = {},
  ) {
    const { generateIdentityKey, signerOf } = await import(
      "../../lib/src/index.js"
    );
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("asked");
    const signer = await signerOf(await generateIdentityKey());
    const storage = memoryStorage();
    let state: import("../account/sign-in.js").AccountState = {
      kind: "signed-out",
      ready: true,
    };
    const listeners = new Set<() => void>();
    const account = {
      starts: 0,
      recentStarts: 0,
      refreshes: 0,
      state: () => state,
      start: (startOptions?: { recent?: boolean }) => {
        account.starts += 1;
        if (startOptions?.recent) account.recentStarts += 1;
        state = { kind: "pending" };
        for (const listener of [...listeners]) listener();
      },
      cancels: 0,
      cancel: () => {
        account.cancels += 1;
        state = { kind: "signed-out", ready: true };
        for (const listener of [...listeners]) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      recent: () => false,
      signedIn: () => {
        state = {
          kind: "signed-in",
          name: "Ada",
          email: null,
          issuer: "i",
          sub: "s",
        };
        for (const listener of [...listeners]) listener();
      },
      signedOut: () => {
        state = { kind: "signed-out", ready: true };
        for (const listener of [...listeners]) listener();
      },
    };
    let opened: OpenedDocument | undefined;
    const view = await mountDocumentView(
      root,
      environment(server, {
        storage,
        openDocument: async (options) => {
          opened = await openDocument({
            ...options,
            socketFactory: () => server.connect(),
          });
          return opened;
        },
      }),
      {
        ...target,
        identity: {
          signer: async () => signer,
          accountSigner: async () => undefined,
          fingerprints: async () => [],
          subscribe: async () => () => {},
          subscribeKey: async () => () => {},
          replaceRefused: async () => "none" as const,
          registrable: async () => false,
        },
        trust: Promise.resolve({
          attestationKeys: new Set<string>(),
          revocations: { current: () => undefined, subscribe: () => () => {} },
          attestation: () => undefined,
          refresh: async () => {
            account.refreshes += 1;
            return options.attestation;
          },
          refusedKey: () => undefined,
          subscribe: () => () => {},
          setTimer: () => () => {},
          account: Promise.resolve(account),
          ...(options.orgName && { orgName: options.orgName }),
          close: () => {},
        }),
        ...(options.association && { association: options.association }),
        ...(options.openHome && { openHome: options.openHome }),
      },
    );
    if (!opened) throw new Error("not opened");
    const doc = opened.annotationsDoc;
    const { editor, panel } = opened.client;
    editor.view.dispatch({ changes: { from: 0, insert: "Bonjour le monde" } });
    const comment = (from: number) => {
      editor.view.dispatch({ selection: { anchor: from, head: from + 3 } });
      expect(panel.create("comment", "?", "")).toBeUndefined();
    };
    const written = () => doc.getMap("annotations").size;
    /** The names the annotations carry, in no order. */
    const authors = () =>
      Object.values(doc.getMap("annotations").toJSON() as object)
        .map((a) => (a as { author?: string }).author)
        .sort();
    const dialog = () =>
      root.querySelector<HTMLDialogElement>("dialog.sign-to-name");
    // Let the trust's promises be applied.
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    return { view, root, storage, account, comment, written, authors, dialog };
  }

  test("« Continuer sans »: written, remembered, not asked again", async () => {
    const s = await setUpView();
    s.comment(0);
    await vi.waitFor(() => expect(s.dialog()?.open).toBe(true));
    expect(s.written()).toBe(0);
    s.dialog()
      ?.querySelector<HTMLButtonElement>(".sign-to-name-without")
      ?.click();
    await vi.waitFor(() => expect(s.written()).toBe(1));
    expect(s.dialog()?.open).toBe(false);
    expect(s.storage.getItem("obsidian-collab:sign-to-name")).toBe("without");
    s.comment(4);
    await vi.waitFor(() => expect(s.written()).toBe(2));
    expect(s.dialog()?.open).toBe(false);
    await s.view.close();
  });

  test("« S'identifier »: written once signed in, after asking for the attestation", async () => {
    const s = await setUpView();
    s.comment(0);
    await vi.waitFor(() => expect(s.dialog()?.open).toBe(true));
    s.dialog()
      ?.querySelector<HTMLButtonElement>(".sign-to-name-sign-in")
      ?.click();
    expect(s.account.starts).toBe(1);
    expect(s.dialog()?.textContent).toContain(t().signInPending);
    expect(s.written()).toBe(0);
    s.account.signedIn();
    await vi.waitFor(() => expect(s.written()).toBe(1));
    expect(s.account.refreshes).toBe(1);
    expect(s.dialog()?.open).toBe(false);
    await s.view.close();
  });

  // Analysis 18o.2: the identity in the document menu.
  test("the menu says « S'identifier », then the identity and whether it is the name", async () => {
    const associated = { kind: "associated" } as const;
    const s = await setUpView({
      association: Promise.resolve({
        situation: () => associated,
        subscribe: () => () => {},
        settled: async () => {},
      } as never),
      attestation: "attested",
      orgName: "Démo",
    });
    const line = () => s.root.querySelector(".identity-line");
    await vi.waitFor(() => expect(line()).not.toBeNull());
    expect(line()?.textContent).toContain(t().identityOf("Démo"));
    line()?.querySelector<HTMLButtonElement>(".identity-sign-in")?.click();
    expect(s.account.starts).toBe(1);
    s.account.signedIn();
    await vi.waitFor(() =>
      expect(line()?.textContent).toContain(t().identityAttested),
    );
    expect(line()?.textContent).toContain("Ada");
    await s.view.close();
  });

  // Found at the real trial (2026-10-20): signed in, the comments carried
  // the pseudonym chosen before; signed out, it is back.
  test("signed in, what is written carries the identity's name; signed out, the pseudonym", async () => {
    const s = await setUpView();
    s.storage.setItem("obsidian-collab:sign-to-name", "without");
    const field = () =>
      s.root.querySelector<HTMLInputElement>(".pseudonym-input");
    s.account.signedIn();
    await vi.waitFor(() => expect(field()?.value).toBe("Ada"));
    expect(field()?.disabled).toBe(true);
    s.comment(0);
    await vi.waitFor(() => expect(s.written()).toBe(1));

    s.account.signedOut();
    expect(field()?.value).toBe("alice");
    s.comment(4);
    await vi.waitFor(() => expect(s.written()).toBe(2));
    expect(s.authors()).toEqual(["Ada", "alice"]);
    expect(s.storage.getItem("obsidian-collab:pseudonym")).toBe("alice");
    await s.view.close();
  });

  // Analysis 18o.3, IC4: signed in, the identity to confirm — asked when
  // writing, « Confirmer » a recent sign-in, what was written then sent.
  test("signed in, the identity to confirm: asked when writing; « Confirmer », then written", async () => {
    const s = await setUpView({
      association: Promise.resolve({
        situation: () => ({ kind: "associated" }),
        subscribe: () => () => {},
        settled: async () => {},
        retry: async () => {},
      } as never),
      attestation: "needs-recent",
    });
    s.account.signedIn();
    s.comment(0);
    await vi.waitFor(() =>
      expect(s.dialog()?.querySelector(".sign-to-name-confirm")).not.toBeNull(),
    );
    expect(s.dialog()?.textContent).toContain(t().signToNameSignedInTitle);
    expect(s.written()).toBe(0);
    s.dialog()
      ?.querySelector<HTMLButtonElement>(".sign-to-name-confirm")
      ?.click();
    expect(s.account.recentStarts).toBe(1);
    s.account.signedIn();
    await vi.waitFor(() => expect(s.written()).toBe(1));
    // Asked once a page.
    s.comment(4);
    await vi.waitFor(() => expect(s.written()).toBe(2));
    expect(s.storage.getItem("obsidian-collab:sign-to-name")).toBeNull();
    await s.view.close();
  });

  // Analysis 18o.3, IC5: in the bar, without opening the menu.
  test("signed in, the identity to confirm: a chip in the bar, a recent sign-in", async () => {
    const s = await setUpView({
      association: Promise.resolve({
        situation: () => ({ kind: "associated" }),
        subscribe: () => () => {},
        settled: async () => {},
        retry: async () => {},
      } as never),
      attestation: "needs-recent",
    });
    const chip = () => s.root.querySelector<HTMLElement>(".identity-chip");
    s.account.signedIn();
    await vi.waitFor(() =>
      expect(chip()?.getAttribute("aria-label")).toBe(t().identityConfirm),
    );
    chip()?.click();
    expect(s.account.recentStarts).toBe(1);
    await s.view.close();
  });

  // IC5, precised (2026-10-30): a link opened signed out, the sign-in in
  // the bar, without opening the menu; under way, it cancels.
  test("signed out: a chip in the bar signs in, then cancels", async () => {
    const s = await setUpView();
    const chip = () => s.root.querySelector<HTMLElement>(".identity-chip");
    await vi.waitFor(() =>
      expect(chip()?.getAttribute("aria-label")).toBe(t().signIn),
    );
    chip()?.click();
    expect(s.account.starts).toBe(1);
    expect(s.account.recentStarts).toBe(0);
    expect(chip()?.getAttribute("aria-label")).toBe(t().identityChipCancel);
    chip()?.click();
    expect(s.account.cancels).toBe(1);
    expect(chip()?.getAttribute("aria-label")).toBe(t().signIn);
    s.account.signedIn();
    await vi.waitFor(() => expect(chip()).toBeNull());
    await s.view.close();
  });

  test("signed in, the list to associate: the reason, and the way to the home page", async () => {
    const s = await setUpView({
      association: Promise.resolve({
        situation: () => ({ kind: "ask", count: 2, titles: [] }),
        subscribe: () => () => {},
        settled: async () => {},
      } as never),
    });
    s.account.signedIn();
    const line = () => s.root.querySelector(".identity-line");
    await vi.waitFor(() =>
      expect(line()?.textContent).toContain(t().identityNotYet),
    );
    const home = line()?.querySelector<HTMLAnchorElement>(".identity-home");
    expect(home?.textContent).toBe(t().identityAssociate);
    expect(new URL(home?.href ?? "").pathname).toBe("/");
    await s.view.close();
  });

  // Found in the plugin (2026-10-22): the home page opened in the browser,
  // whose list is another device's; Obsidian's chip stayed. A host with
  // its own « Mes documents » is where the list here is seen to.
  test("a host's own « Mes documents »: the chip, the menu and the dialog open it", async () => {
    let opened = 0;
    const s = await setUpView({
      association: Promise.resolve({
        situation: () => ({ kind: "open-here", count: 0 }),
        subscribe: () => () => {},
        settled: async () => {},
      } as never),
      openHome: () => {
        opened += 1;
      },
    });
    s.account.signedIn();
    const chip = () => s.root.querySelector<HTMLElement>(".identity-chip");
    await vi.waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()?.tagName).toBe("BUTTON");
    chip()?.click();
    expect(opened).toBe(1);

    const home = s.root.querySelector<HTMLElement>(
      ".identity-line .identity-home",
    );
    expect(home?.tagName).toBe("BUTTON");
    expect(home?.textContent).toBe(t().identityOpenHere);
    home?.click();
    expect(opened).toBe(2);

    // Writing asks; the host's list opened, what is written goes on.
    s.comment(0);
    const dialogHome = () =>
      s.dialog()?.querySelector<HTMLElement>(".sign-to-name-home");
    await vi.waitFor(() => expect(dialogHome()).not.toBeNull());
    expect(dialogHome()?.tagName).toBe("BUTTON");
    dialogHome()?.click();
    expect(opened).toBe(3);
    await vi.waitFor(() => expect(s.written()).toBe(1));
    expect(s.root.querySelector("a[target=_blank]")).toBeNull();
    await s.view.close();
  });
});

// Phase 38c: what only some hosts give the view — the images, the
// measures.
describe("a view with what its host may give", () => {
  test("an edit link, the server taking images: they are offered, and an attached one's bytes asked of the view", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("images");
    const view = await mountDocumentView(
      root,
      environment(server, {
        fetch: () => Promise.reject(new TypeError("offline")),
        objectUrls: { create: () => "blob:x", revoke: () => {} },
        attachmentLimits: async () => ({
          imageBytes: 1_000_000,
          documentBytes: 10_000_000,
        }),
      }),
      target,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.image).toBeDefined();
    expect(await view.image?.("absent")).toBeUndefined();
    const editor = root.querySelector<HTMLElement>(".cm-editor");
    const cm = editor && EditorView.findFromDOM(editor);
    expect(cm && mayInsertImage(cm.state)).toBe(true);
    expect(root.querySelector(".image-uploads")).not.toBeNull();
    await view.close();
  });

  test("without object URLs, no image is offered", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("no-images");
    const view = await mountDocumentView(
      root,
      environment(server, {
        fetch: () => Promise.reject(new TypeError("offline")),
        attachmentLimits: async () => ({
          imageBytes: 1_000_000,
          documentBytes: 10_000_000,
        }),
      }),
      target,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.image).toBeUndefined();
    expect(root.querySelector(".image-uploads")).toBeNull();
    await view.close();
  });

  test("`?perf`: the counters on the window, the opening measured in the console", async () => {
    document.body.innerHTML = "";
    const server = new FakeServer();
    const root = document.createElement("div");
    document.body.append(root);
    const { target } = await newDocument("measured");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const table = vi.spyOn(console, "table").mockImplementation(() => {});
    onTestFinished(() => {
      info.mockRestore();
      table.mockRestore();
    });
    const window = new EventTarget();
    const view = await mountDocumentView(
      root,
      environment(server, { window }),
      { ...target, perf: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect("ocCounters" in window).toBe(true);
    const said = info.mock.calls.map(([text]) => String(text));
    expect(said.some((text) => text.startsWith("[perf] connect→settled"))).toBe(
      true,
    );
    expect(
      said.some((text) => text.startsWith("[perf] connect→signatures")),
    ).toBe(true);
    await view.close();
  });
});
