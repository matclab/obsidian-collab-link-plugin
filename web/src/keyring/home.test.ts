import { IDBFactory } from "fake-indexeddb";
import { flushSync } from "svelte";
import { describe, expect, test } from "vitest";
import {
  type KeyringCredentials,
  createKeyring,
  formatKeyringLink,
  noteRefused,
  parseKeyringLink,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import { testLink } from "../../lib/src/keyring/test-support/links.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "./environment.js";
import { type HomeView, mountHome } from "./home.js";
import { type KeyringLock, openKeyringLocal } from "./local.js";
// @vitest-environment jsdom
//
// The page's home (phase 18, decisions 3, 7 and 19; 18d): without a
// keyring, how to keep or find one; keeping one shows its key once; a key
// pasted on another device opens the same list; removing a document; a
// renewed document takes its new link; a list gone from the server is
// kept under a new key (cas 12). On fake-indexeddb and a keyring server
// in memory.
import { linkOf } from "./ref.js";

const ORIGIN = "https://collab.test";

function memoryLock(): KeyringLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exclusive(_name, run) {
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
  };
}

/** One device: its IndexedDB, its timers (run at once). */
function device(server: FakeKeyringServer): KeyringEnvironment {
  return {
    local: openKeyringLocal({
      indexedDB: new IDBFactory(),
      lock: memoryLock(),
    }),
    fetch: server.fetch,
    setTimer: (run) => {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
  };
}

function home(
  keyring: KeyringEnvironment | undefined,
  server: FakeKeyringServer,
  confirm = true,
): HomeView {
  document.body.innerHTML = "";
  return mountHome(document.body, {
    apiBase: ORIGIN,
    ...(keyring && { keyring }),
    createKeyring: () => createKeyring(ORIGIN, server.fetch),
    confirm: () => confirm,
    copy: async () => {},
    now: () => 1_000,
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const text = () => document.body.textContent ?? "";
const click = (selector: string) => {
  $(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flushSync();
};
const type = (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};

describe("the home", () => {
  test("without storage on this device: a new document only, and why not more", async () => {
    const view = home(undefined, new FakeKeyringServer());
    await view.ready;
    expect($(".home-new")?.getAttribute("href")).toBe("?new");
    expect(text()).toContain(t().keyringUnavailable);
    expect($(".home-keep")).toBeNull();
  });

  test("keeping my documents shows the key once; another device opens the same list with it", async () => {
    const server = new FakeKeyringServer();
    const first = device(server);
    const view = home(first, server);
    await view.ready;
    expect(text()).toContain(t().myDocumentsIntro);
    click(".home-keep");
    await eventually(() => $(".home-key") !== null);
    const key = $<HTMLInputElement>(".home-key")?.value ?? "";
    expect(() => parseKeyringLink(key)).not.toThrow();
    expect(text()).toContain(t().noDocumentsYet);
    click(".home-kept");
    expect($(".home-key")).toBeNull();
    // A document opened on this device.
    const session = view.session();
    await session?.change(
      (doc) =>
        void rememberLink(doc, testLink("d1", "edit", 0, `${ORIGIN}/`), {
          at: 1,
        }),
    );
    await session?.sync();
    // Another device: a wrong key, then the right one.
    view.close();
    const other = home(device(server), server);
    await other.ready;
    type(".home-find", "not a key");
    click(".home-open");
    await eventually(() => text().includes(t().keyInvalid));
    type(".home-find", key);
    click(".home-open");
    await eventually(() => $(".home-entry") !== null);
    expect($(".home-entry")?.getAttribute("data-document")).toBe("d1");
    expect($<HTMLAnchorElement>(".home-entry-link")?.href).toBe(
      testLink("d1", "edit", 0, `${ORIGIN}/`),
    );
    other.close();
  });

  test("a key of no list here is said so, and forgotten", async () => {
    const server = new FakeKeyringServer();
    const elsewhere = await createKeyring(
      ORIGIN,
      new FakeKeyringServer().fetch,
    );
    const env = device(server);
    const view = home(env, server);
    await view.ready;
    type(".home-find", elsewhere.link);
    click(".home-open");
    await eventually(() => text().includes(t().keyNotFound));
    expect(await env.local.load()).toBeUndefined();
    view.close();
  });

  test("removing a document, and pasting a renewed one's new link", async () => {
    const server = new FakeKeyringServer();
    const view = home(device(server), server);
    await view.ready;
    click(".home-keep");
    await eventually(() => view.session() !== undefined);
    const session = view.session();
    await session?.change((doc) => {
      rememberLink(doc, testLink("d1", "edit", 0, `${ORIGIN}/`), { at: 1 });
      rememberLink(doc, testLink("d2", "read", 0, `${ORIGIN}/`), { at: 2 });
      noteRefused(doc, testLink("d2", "read", 0, `${ORIGIN}/`));
    });
    await eventually(
      () => document.querySelectorAll(".home-entry").length === 2,
    );
    expect(text()).toContain(t().stateRenewed);
    // The new link of another document is refused.
    type(".home-new-link", testLink("d1", "read", 1, `${ORIGIN}/`));
    click(".home-save-link");
    expect(text()).toContain(t().linkNotThisDocument);
    // Nor a link of the right document on another server (security
    // review of 18d: a lookalike page, opened from « Mes documents »).
    type(
      ".home-new-link",
      testLink("d2", "read", 1, "https://elsewhere.example/"),
    );
    click(".home-save-link");
    expect(text()).toContain(t().stateRenewed);
    type(".home-new-link", testLink("d2", "read", 1, `${ORIGIN}/`));
    click(".home-save-link");
    await eventually(() => !text().includes(t().stateRenewed));
    // Removed: gone from the list, and not added back (KR-24).
    click('.home-entry[data-document="d1"] .home-remove');
    await eventually(
      () => document.querySelectorAll(".home-entry").length === 1,
    );
    view.close();
  });

  test("cas 12: a list gone from the server is said so, and kept under a new key", async () => {
    const server = new FakeKeyringServer();
    const view = home(device(server), server);
    await view.ready;
    click(".home-keep");
    await eventually(() => view.session() !== undefined);
    const first = view.session();
    await first?.change(
      (doc) =>
        void rememberLink(doc, testLink("d1", "edit", 0, `${ORIGIN}/`), {
          at: 1,
        }),
    );
    await first?.sync();
    click(".home-kept");
    server.delete(first?.ref.keyringId ?? "");
    await first?.sync();
    await eventually(() => text().includes(t().keyringGone));
    click(".home-recreate");
    await eventually(() => $(".home-key") !== null);
    const second = view.session();
    expect(second?.ref.keyringId).not.toBe(first?.ref.keyringId);
    expect($<HTMLInputElement>(".home-key")?.value).toBe(
      formatKeyringLink(
        linkOf(second?.ref ?? (first as NonNullable<typeof first>).ref),
      ),
    );
    expect(document.querySelectorAll(".home-entry")).toHaveLength(1);
    expect(server.keyrings.has(second?.ref.keyringId ?? "")).toBe(true);
    view.close();
  });

  // 18e (decision 6, KR-29, KR-30).
  test("changing the key: the new key shown, the old one gone; another device pastes it, and its copy joins", async () => {
    document.body.innerHTML = "";
    const server = new FakeKeyringServer();
    /** A device's home, in its own element. */
    const open = async (env: KeyringEnvironment) => {
      const root = document.createElement("div");
      document.body.append(root);
      const view = mountHome(root, {
        apiBase: ORIGIN,
        keyring: env,
        createKeyring: () => createKeyring(ORIGIN, server.fetch),
        confirm: () => true,
        copy: async () => {},
        now: () => 1_000,
      });
      await view.ready;
      const in_ = <T extends Element = HTMLElement>(selector: string) =>
        root.querySelector<T>(selector);
      const press = (selector: string) => {
        in_(selector)?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
        flushSync();
      };
      const fill = (selector: string, value: string) => {
        const input = in_<HTMLInputElement>(selector);
        if (!input) throw new Error(`no ${selector}`);
        input.value = value;
        flushSync();
      };
      return {
        view,
        root,
        in_,
        press,
        fill,
        says: (s: string) => (root.textContent ?? "").includes(s),
      };
    };
    const a = await open(device(server));
    a.press(".home-keep");
    await eventually(() => a.view.session() !== undefined);
    const first = a.view.session() as NonNullable<
      ReturnType<HomeView["session"]>
    >;
    await first.change(
      (doc) =>
        void rememberLink(doc, testLink("d1", "edit", 0, `${ORIGIN}/`), {
          at: 1,
        }),
    );
    await first.sync();
    a.press(".home-kept");

    // The other device, on the old key, writes a document of its own.
    const b = await open(device(server));
    b.fill(".home-find", formatKeyringLink(linkOf(first.ref)));
    b.press(".home-open");
    await eventually(() => b.root.querySelectorAll(".home-entry").length === 1);
    await b.view.session()?.change(
      (doc) =>
        void rememberLink(doc, testLink("d2", "edit", 0, `${ORIGIN}/`), {
          at: 2,
        }),
    );
    await b.view.session()?.sync();

    // The first device changes the key.
    a.press(".home-change-key");
    await eventually(() => !server.keyrings.has(linkOf(first.ref).keyringId));
    // Still said once the new keyring is synced: a status clears only a
    // status.
    await a.view.session()?.sync();
    expect(a.says(t().keyChanged)).toBe(true);
    const next = a.view.session()?.ref as KeyringCredentials;
    expect(next.keyringId).not.toBe(first.ref.keyringId);
    expect(a.in_<HTMLInputElement>(".home-key")?.value).toBe(
      formatKeyringLink(next),
    );

    // The other device finds its keyring gone; the new key is pasted.
    await b.view.session()?.sync();
    await eventually(() => b.says(t().keyringGone));
    b.fill(".home-new-key", formatKeyringLink(next));
    b.press(".home-use-new-key");
    await eventually(() => b.view.session()?.ref.keyringId === next.keyringId);
    await eventually(() => b.root.querySelectorAll(".home-entry").length === 2);
    await a.view.session()?.sync();
    expect(
      a.view
        .session()
        ?.entries()
        .map((e) => e.documentId),
    ).toEqual(["d1", "d2"]);
    a.view.close();
    b.view.close();
  });
});
