// @vitest-environment jsdom
//
// The page's entry for another host (docs/phase-14-plugin-obsidian.md,
// decision 2): the Obsidian plugin reaches the page's code only through
// `embed.ts`, as the page reaches the library only through its `index.ts`
// (`lib/src/boundary.test.ts`); and the page's code looks nothing up in the
// window — no `getElementById`, no `document.body`, no `localStorage` —
// outside `main.ts`, so that several views can share one. Read from the
// sources.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test, vi } from "vitest";
import {
  createDocument,
  documentLinks,
  parseLinkFragment,
} from "../lib/src/index.js";
import { FakeServer } from "../lib/src/transport/test-support/fake-server.js";
import {
  type DocumentViewEnvironment,
  type EditorFactory,
  type MountedView,
  mountDocumentView,
  openDocument,
} from "./embed.js";

const WEB = resolve(import.meta.dirname, "..");
const PAGE = join(WEB, "src");
const LIB = join(WEB, "lib/src");
const PLUGIN = resolve(WEB, "../obsidian/src");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module a file names: imports, re-exports, dynamic imports,
 * mocks. */
function specifiers(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found = text.matchAll(
    /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\bvi\.mock\(\s*)"([^"\n]+)"/g,
  );
  return [...found].map((match) => match[1] as string);
}

const isTest = (path: string) =>
  path.endsWith(".test.ts") || path.includes("/test-support/");

/** The modules of `area` that `from`'s files name, other than `entry`;
 * its tests' too, unless `tests` says they may. */
function deepImports(
  from: string,
  area: string,
  entry: string,
  tests: "checked" | "free" = "checked",
): string[] {
  const checked = files(from).filter(
    (path) => tests === "checked" || !isTest(path),
  );
  return checked.flatMap((path) =>
    specifiers(path)
      .filter((spec) => {
        if (!spec.startsWith(".")) return false;
        const target = resolve(path, "..", spec).replace(/\.js$/, ".ts");
        return target.startsWith(area) && target !== entry;
      })
      .map((spec) => `${relative(WEB, path)}: ${spec}`),
  );
}

/** Test tools of the page, which build their own elements. */
const PAGE_HELPERS = ["integration/", "bench/", "e2e/", "perf/harness.ts"];

describe("the page's entry for another host", () => {
  test("the plugin reaches the page only through it, and the library only through its entry", () => {
    expect(deepImports(PLUGIN, PAGE, join(PAGE, "embed.ts"))).toEqual([]);
    // Its tests may use the library's test tools, as the page's do.
    expect(deepImports(PLUGIN, LIB, join(LIB, "index.ts"), "free")).toEqual([]);
  });

  test("the page's code looks nothing up in the window outside main.ts", () => {
    const global = /\b(?:getElementById|document\.body|localStorage)\b/;
    // The entries of its pages: the page's, and the return of a sign-in's
    // (ADR-0041), a page of its own.
    const entries = [join(PAGE, "main.ts"), join(PAGE, "auth-return.ts")];
    const found = files(PAGE)
      .filter(
        (path) =>
          !isTest(path) &&
          !entries.includes(path) &&
          !PAGE_HELPERS.some((helper) =>
            relative(PAGE, path).startsWith(helper),
          ),
      )
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .map((line, at) => ({ line, at }))
          // Comments may name them.
          .filter(({ line }) =>
            global.test(line.replace(/\/\/.*|^\s*\*.*/, "")),
          )
          .map(({ at }) => `${relative(WEB, path)}:${at + 1}`),
      );
    expect(found).toEqual([]);
  });

  /** Mounts a read link's document (an edit link's, `edit`) in an
   * element of the host's. */
  async function mount(
    more: Partial<DocumentViewEnvironment> = {},
    edit = false,
  ): Promise<{ root: HTMLElement; view: MountedView }> {
    document.body.innerHTML = "";
    const root = document.createElement("div");
    document.body.append(root);
    const server = new FakeServer();
    const created = await createDocument("https://collab.test", async () =>
      Response.json({ document_id: "doc" }),
    );
    const links = await documentLinks(
      "https://collab.test/",
      "doc",
      created.keyMaterial,
      created.editSecret,
    );

    const view = await mountDocumentView(
      root,
      {
        reload: () => {},
        storage: undefined,
        indexedDB: undefined,
        lock: undefined,
        online: () => true,
        window: new EventTarget(),
        confirm: () => true,
        copy: async () => {},
        documentLinks,
        openDocument: (options) =>
          openDocument({ ...options, socketFactory: () => server.connect() }),
        ...more,
      },
      {
        apiBase: "https://collab.test",
        documentId: "doc",
        // A read link: no name to ask for; an edit link, a name signed in.
        link: parseLinkFragment(new URL(edit ? links.edit : links.read).hash),
        ...(edit && { signedInName: async () => "Ada" }),
        linkBase: () => "https://collab.test/",
      },
    );
    return { root, view };
  }

  test("mounts a document in an element of the host's", async () => {
    const { root } = await mount();

    expect(root.querySelector(".cm-editor")).not.toBeNull();
  });

  // Phase 17, decision 4: the plugin's, Obsidian's editor in Write.
  test("writes in the host's editor when it brings one, and gives it back on close", async () => {
    const built: Element[] = [];
    let destroyed = 0;
    const editor: EditorFactory = (parent, setup) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: setup.doc,
          extensions: setup.extensions,
        }),
        parent,
      });
      view.dom.classList.add("host-editor");
      built.push(parent);
      return {
        view,
        destroy() {
          destroyed++;
          view.destroy();
        },
      };
    };

    const { root, view } = await mount({ editor });

    expect(built).toHaveLength(1);
    expect(root.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(root.querySelector(".cm-editor.host-editor")).not.toBeNull();
    await view.close();
    expect(destroyed).toBe(1);
  });

  // Phase 33f: who wrote, in the host's editor, with its own extensions.
  test("who wrote tints the text of the host's editor", async () => {
    const editor: EditorFactory = (parent, setup) => {
      const view = new EditorView({
        state: EditorState.create({
          doc: setup.doc,
          extensions: setup.extensions,
        }),
        parent,
      });
      view.dom.classList.add("host-editor");
      return { view, destroy: () => view.destroy() };
    };
    const { root, view } = await mount({ editor }, true);
    const host = root.querySelector<HTMLElement>(".cm-editor.host-editor");
    const cm = host && EditorView.findFromDOM(host);
    if (!cm) throw new Error("no editor");
    cm.dispatch({ changes: { from: 0, insert: "typed here" } });

    root.querySelector<HTMLButtonElement>(".authorship-toggle")?.click();
    await vi.waitFor(() =>
      expect(host.querySelector(".cm-author")?.textContent).toBe("typed here"),
    );
    expect(root.querySelector(".authorship-legend")?.textContent).toContain(
      "Ada",
    );
    await view.close();
  });
});
