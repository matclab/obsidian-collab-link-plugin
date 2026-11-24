// @vitest-environment jsdom
//
// What the view decides on its own, against a host of the test's: a
// document another view holds — said, a heading asked handed to that view,
// the focus alone kept (decision 13); its tab moved on while the document
// still opens — the document let go once that opening has ended, nothing
// mounted (the user's report of 2026-11-07).
import { describe, expect, test, vi } from "vitest";
import { DOCUMENT_VIEW, DocumentLeafView, type ViewHost } from "./leaf-view.js";
import { writeHeader } from "./note-header.js";
import { FakeApp, type WorkspaceLeaf } from "./test-support/obsidian.js";

/** A view of a linked note `n.md`, its document `doc`, on `host`. */
async function viewOf(host: Partial<ViewHost>) {
  const app = new FakeApp();
  await app.vault.create(
    "n.md",
    writeHeader("text", { document: "doc", version: "" }),
  );
  const full = {
    links: {
      get: () => ({
        apiBase: "https://collab.test",
        documentId: "doc",
        fragment: "#k=key",
      }),
    },
    views: {
      claim: async () => false,
      live: () => undefined,
      release: vi.fn(),
    },
    workspace: { reveal: vi.fn() },
    ...host,
  } as unknown as ViewHost;
  app.workspace.creators.set(
    DOCUMENT_VIEW,
    (leaf: WorkspaceLeaf) => new DocumentLeafView(leaf as never, full) as never,
  );
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: DOCUMENT_VIEW, state: { file: "n.md" } });
  const view = leaf.view as unknown as DocumentLeafView;
  return { app, leaf, view, host: full };
}

describe("a document another view holds (decision 13)", () => {
  test("said, with a way to that view's tab", async () => {
    const live = { leaf: {}, setEphemeralState: vi.fn() };
    const { view, host } = await viewOf({
      views: {
        claim: async () => false,
        live: () => live as never,
        release: vi.fn(),
      },
    });
    await view.ready();

    expect(view.containerEl.querySelector(".collab-link-go")).not.toBeNull();
    view.containerEl
      .querySelector<HTMLButtonElement>(".collab-link-go")
      ?.click();
    expect(host.workspace.reveal).toHaveBeenCalledWith(live.leaf);
  });

  test("a heading asked goes to that view, and shows it; the focus alone stays", async () => {
    const live = { leaf: {}, setEphemeralState: vi.fn() };
    const { view, host } = await viewOf({
      views: {
        claim: async () => false,
        live: () => live as never,
        release: vi.fn(),
      },
    });
    await view.ready();

    view.setEphemeralState({ focus: true });
    expect(live.setEphemeralState).not.toHaveBeenCalled();
    view.setEphemeralState({ line: 3 });
    expect(live.setEphemeralState).toHaveBeenCalledWith({
      line: 3,
      focus: true,
    });
    expect(host.workspace.reveal).toHaveBeenCalledWith(live.leaf);
  });

  test("a heading asked while it still asks for the document goes there once refused", async () => {
    const live = { leaf: {}, setEphemeralState: vi.fn() };
    let refuse = (_: boolean) => {};
    const { view } = await viewOf({
      views: {
        claim: () =>
          new Promise<boolean>((resolve) => {
            refuse = resolve;
          }),
        live: () => live as never,
        release: vi.fn(),
      },
    });

    view.setEphemeralState({ subpath: "#Part" });
    expect(live.setEphemeralState).not.toHaveBeenCalled();
    refuse(false);
    await view.ready();
    expect(live.setEphemeralState).toHaveBeenCalledWith({
      subpath: "#Part",
      focus: true,
    });
  });
});

describe("its tab moved on while the document still opens", () => {
  test("the document is let go once that opening has ended; nothing is mounted", async () => {
    let identify = () => {};
    let asked = () => {};
    const identifying = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const documentIdentity = () => {
      asked();
      return new Promise<object>((resolve) => {
        identify = () => resolve({});
      });
    };
    const release = vi.fn();
    const { leaf, view } = await viewOf({
      views: { claim: async () => true, live: () => undefined, release },
      documentIdentity,
      editorFor: () => undefined,
      environment: () => ({}) as never,
      applyLanguage: () => {},
      workspace: {
        reveal: vi.fn(),
        isActive: () => true,
        onActiveLeafChange: () => () => {},
      },
    });
    await identifying;

    await leaf.detach();
    expect(release).toHaveBeenCalledTimes(1);
    const [documentId, by, closed] = release.mock.calls[0] ?? [];
    expect([documentId, by]).toEqual(["doc", view]);
    let free = false;
    void (closed as Promise<void>).then(() => {
      free = true;
    });
    await Promise.resolve();
    expect(free).toBe(false);

    identify();
    await view.idle();
    expect(free).toBe(true);
    expect(view.containerEl.querySelector(".collab-link-message")).toBeNull();
  });
});
