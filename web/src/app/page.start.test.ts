import { IDBFactory } from "fake-indexeddb";
// @vitest-environment jsdom
//
// The ways the page starts besides opening a link that works
// (`page.property.test.ts`): an address without a document creates one, a
// link it can't read says so, a refusal at opening says why.
import { describe, expect, test, vi } from "vitest";
import {
  CloseCode,
  ConnectionRefused,
  createDocument,
  createKeyring,
  documentLinks,
  newKeyringDoc,
  rememberLink,
} from "../../lib/src/index.js";
import { FakeKeyringServer } from "../../lib/src/keyring/test-support/fake-keyring-server.js";
import {
  testLink,
  testSecret,
} from "../../lib/src/keyring/test-support/links.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "../keyring/environment.js";
import { sessionOptions } from "../keyring/environment.js";
import { openKeyringLocal } from "../keyring/local.js";
import { KeyringSession } from "../keyring/session.js";
import { refusalMessage } from "./messages.js";
import type { PageEnvironment } from "./page.js";
import { startPage } from "./page.js";

const ORIGIN = "https://collab.test";

function environment(
  href: string,
  overrides: Partial<PageEnvironment> = {},
): PageEnvironment & { address: URL } {
  document.body.innerHTML = "";
  const address = new URL(href);
  const items = new Map([["obsidian-collab:pseudonym", "alice"]]);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as unknown as Storage;
  return {
    root: document.body,
    address,
    location: () => address,
    replaceAddress: (url) => {
      address.href = url;
    },
    reload: () => {},
    storage,
    indexedDB: undefined,
    lock: undefined,
    languages: ["en"],
    online: () => true,
    window: new EventTarget(),
    confirm: () => true,
    copy: async () => {},
    registerServiceWorker: async () => {},
    createDocument: () => Promise.reject(new Error("unexpected")),
    createKeyring: () => Promise.reject(new Error("unexpected")),
    now: () => Date.now(),
    documentLinks,
    openDocument: () => Promise.reject(new Error("unexpected")),
    ...overrides,
  };
}

const notices = () =>
  document.querySelector(".view-notices")?.textContent ?? "";

describe("starting the page", () => {
  test("an address without a document shows the home, and creates nothing", async () => {
    const create = vi.fn();
    const env = environment(`${ORIGIN}/`, { createDocument: create });

    await startPage(env);

    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector(".home-new")?.getAttribute("href")).toBe(
      "?new",
    );
    expect(document.body.textContent).toContain(t().keyringUnavailable);
  });

  // KR-37: the pairing key leaves the address before the deposit is taken.
  test("`?pair=` is removed from the address first, then the deposit taken", async () => {
    const events: string[] = [];
    const id = "fedcba9876543210fedcba9876543210";
    const env = environment(`${ORIGIN}/?pair=${id}#p=${"A".repeat(43)}`, {
      keyring: {
        local: openKeyringLocal({
          indexedDB: new IDBFactory(),
          lock: { exclusive: (_name, run) => run() },
        }),
        fetch: async (url) => {
          events.push(`fetch ${new URL(url).pathname}`);
          return new Response(null, { status: 404 });
        },
        setTimer: () => () => {},
      },
    });
    const replace = env.replaceAddress;
    env.replaceAddress = (url) => {
      events.push(`address ${url}`);
      replace(url);
    };

    await startPage(env);

    expect(events).toEqual([
      `address ${ORIGIN}/`,
      `fetch /pairings/${id}/take`,
    ]);
    expect(document.body.textContent).toContain(t().pairingGone);
  });

  test("a malformed `?pair=` is removed too, and said unreadable", async () => {
    const env = environment(`${ORIGIN}/?pair=nope#p=x`, {
      keyring: {
        local: openKeyringLocal({
          indexedDB: new IDBFactory(),
          lock: { exclusive: (_name, run) => run() },
        }),
        fetch: () => Promise.reject(new Error("unexpected")),
        setTimer: () => () => {},
      },
    });

    await startPage(env);

    expect(env.address.href).toBe(`${ORIGIN}/`);
    expect(document.body.textContent).toContain(t().pairingUnreadable);
  });

  test("`?new` creates a document, and takes its edit link", async () => {
    const created = await createDocument(ORIGIN, async () =>
      Response.json({ document_id: "new-doc" }),
    );
    const refused = new ConnectionRefused(CloseCode.Deleted);
    const env = environment(`${ORIGIN}/?new`, {
      createDocument: async () => created,
      // Its opening is not the point here.
      openDocument: () => Promise.reject(refused),
    });

    await startPage(env);

    const links = await documentLinks(
      `${ORIGIN}/`,
      "new-doc",
      created.keyMaterial,
      created.editSecret,
    );
    expect(env.address.href).toBe(links.edit);
  });

  test("a document that can't be created is said to need the server", async () => {
    const env = environment(`${ORIGIN}/?new`, {
      createDocument: () => Promise.reject(new TypeError("offline")),
    });

    await expect(startPage(env)).rejects.toThrow("offline");

    expect(notices()).toContain(t().createNeedsServer);
  });

  test("a link it can't read is said so, and nothing opens", async () => {
    const open = vi.fn();
    const env = environment(`${ORIGIN}/?doc=doc#nothing-here`, {
      openDocument: open,
    });

    await startPage(env);

    expect(notices()).toContain(t().invalidLink);
    expect(open).not.toHaveBeenCalled();
  });

  test("a refusal at opening says why, and the service worker is still registered", async () => {
    const created = await createDocument(ORIGIN, async () =>
      Response.json({ document_id: "doc" }),
    );
    const links = await documentLinks(
      `${ORIGIN}/`,
      "doc",
      created.keyMaterial,
      created.editSecret,
    );
    const register = vi.fn(async () => {});
    const env = environment(links.read, {
      openDocument: () =>
        Promise.reject(new ConnectionRefused(CloseCode.Revoked)),
      registerServiceWorker: register,
    });

    await startPage(env);

    expect(notices()).toContain(refusalMessage(CloseCode.Revoked));
    expect(register).toHaveBeenCalledOnce();
  });
});

const lock = {
  exclusive: <T>(_name: string, run: () => Promise<T>) => run(),
};

/** « Mes documents » on this device, its copy holding `here`; its server
 * holding `there` too, as another device wrote it; `reachable` or not. */
async function listOnDevice(
  here: string[],
  { there = [] as string[], reachable = true } = {},
): Promise<KeyringEnvironment> {
  const server = new FakeKeyringServer();
  const created = await createKeyring(ORIGIN, server.fetch);
  if (there.length > 0) {
    const other = await KeyringSession.adopt(
      sessionOptions(
        {
          local: openKeyringLocal({ indexedDB: new IDBFactory(), lock }),
          fetch: server.fetch,
          setTimer: () => () => {},
        },
        ORIGIN,
      ),
      created,
    );
    await other?.change((doc) => {
      for (const link of there) rememberLink(doc, link, { at: 1 });
    });
    await other?.sync();
  }
  const local = openKeyringLocal({ indexedDB: new IDBFactory(), lock });
  const doc = newKeyringDoc();
  for (const link of here) rememberLink(doc, link, { at: 1 });
  await local.claim(created, doc);
  return {
    local,
    fetch: reachable
      ? server.fetch
      : () => Promise.reject(new TypeError("offline")),
    setTimer: () => () => {},
  };
}

/** The role and secret the page opened with, if it opened. */
function opening() {
  const asked: { role: string; secret: Uint8Array }[] = [];
  return {
    asked,
    openDocument: (options: {
      credentials: { role: string; secret: Uint8Array };
    }) => {
      asked.push(options.credentials);
      return Promise.reject(new ConnectionRefused(CloseCode.Deleted));
    },
  };
}

// Phase 19, decision 5 and analysis 19b: an address that names a document
// without its key, as a link between documents writes it.
describe("an address without a key", () => {
  const page = `${ORIGIN}/`;

  test("the document in this device's list: opened with its link, which takes the address's place, without `h`", async () => {
    const link = testLink("doc1", "suggest", 0, page);
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc1#h=Partie%20un`, {
      keyring: await listOnDevice([link]),
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(asked).toEqual([
      { role: "suggest", secret: testSecret("doc1", "suggest", 0) },
    ]);
    expect(env.address.href).toBe(link);
  });

  test("not in this device's copy, brought by the list's sync: opened", async () => {
    const link = testLink("doc2", "read", 0, page);
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc2`, {
      keyring: await listOnDevice([], { there: [link] }),
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(asked.map((a) => a.role)).toEqual(["read"]);
    expect(env.address.href).toBe(link);
  });

  test("not in the list, checked: said, nothing opened, the address kept", async () => {
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc3`, {
      keyring: await listOnDevice([testLink("other", "edit", 0, page)]),
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(notices()).toContain(t().keylessAbsent);
    expect(asked).toEqual([]);
    expect(env.address.href).toBe(`${ORIGIN}/?doc=doc3`);
  });

  test("not in this device's copy, the list's server out of reach: said as unchecked", async () => {
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc4`, {
      keyring: await listOnDevice([], {
        there: [testLink("doc4", "edit", 0, page)],
        reachable: false,
      }),
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(notices()).toContain(t().keylessUnchecked);
    expect(asked).toEqual([]);
  });

  test("no list on this device: said", async () => {
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc5`, {
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(notices()).toContain(t().keylessNoList);
    expect(asked).toEqual([]);
  });

  test("a document of another server under that id: not taken", async () => {
    const { asked, openDocument } = opening();
    const env = environment(`${ORIGIN}/?doc=doc6`, {
      keyring: await listOnDevice([
        testLink("doc6", "edit", 0, "https://elsewhere.test/"),
      ]),
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(notices()).toContain(t().keylessAbsent);
    expect(asked).toEqual([]);
  });

  test("a full link with `h`: opened, `h` taken out of the address", async () => {
    const link = testLink("doc7", "edit", 0, page);
    const { asked, openDocument } = opening();
    const env = environment(`${link}&h=Partie%20un`, {
      openDocument: openDocument as PageEnvironment["openDocument"],
    });

    await startPage(env);

    expect(asked.map((a) => a.role)).toEqual(["edit"]);
    expect(env.address.href).toBe(link);
  });
});
