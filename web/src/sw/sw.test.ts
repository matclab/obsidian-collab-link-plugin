// The service worker's wiring (phase 9, 9d; SW2 to SW4; phase 38g): what
// `sw.ts` does with each event, against a worker scope, `caches` and
// `fetch` in memory. The decisions themselves are `strategy.ts`'s and
// `push.ts`'s, tested beside them.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Manifest } from "./strategy.js";

const SCOPE = "https://collab.test/";
const MANIFEST: Manifest = {
  version: "v2",
  entry: "main-abc.js",
  precache: ["index.html", "main-abc.js"],
  files: ["index.html", "main-abc.js", "katex-def.js"],
};
const PAGE = `<script type="module" src="./main-abc.js"></script>`;

/** A `CacheStorage` in memory, by name and address. */
class MemoryCaches {
  readonly stores = new Map<string, Map<string, Response>>();

  async open(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    const kept = store;
    const url = (request: Request | string) =>
      typeof request === "string" ? request : request.url;
    return {
      add: async (request: Request) => {
        kept.set(request.url, await fetchFn(request));
      },
      addAll: async (urls: string[]) => {
        for (const href of urls) kept.set(href, await fetchFn(href));
      },
      put: async (request: Request | string, response: Response) => {
        kept.set(url(request), response);
      },
      match: async (request: Request | string) =>
        kept.get(url(request))?.clone(),
    };
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }
}

/** What the network answers, by address; `offline`, nothing. */
let network: Map<string, () => Response>;
let offline = false;
const fetchFn = async (request: Request | string): Promise<Response> => {
  const href = typeof request === "string" ? request : request.url;
  if (offline) throw new TypeError("offline");
  const answer = network.get(href);
  return answer ? answer() : new Response("not found", { status: 404 });
};

type Listener = (event: Record<string, unknown>) => void;

/** Loads `sw.ts` into a fresh worker scope; its listeners, by type. */
async function worker(languages: readonly string[] = ["en"]) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const windows: { url: string; focused: number }[] = [];
  const opened: string[] = [];
  let claimed = 0;
  const caches = new MemoryCaches();
  vi.stubGlobal("OC_MANIFEST", MANIFEST);
  vi.stubGlobal("caches", caches);
  vi.stubGlobal("fetch", fetchFn);
  vi.stubGlobal("self", {
    registration: {
      scope: SCOPE,
      showNotification: async (
        title: string,
        options: Record<string, unknown>,
      ) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {
        claimed++;
      },
      matchAll: async () =>
        windows.map((client) => ({
          url: client.url,
          focus: async () => {
            client.focused++;
          },
        })),
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
    navigator: { languages },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, listener);
    },
  });
  vi.resetModules();
  await import("./sw.js");
  /** Dispatches `type`, resolves once what it waits for has. */
  const dispatch = async (type: string, fields: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    let responded: Promise<Response> | undefined;
    listeners.get(type)?.({
      ...fields,
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
      respondWith: (promise: Promise<Response>) => {
        responded = promise;
      },
    });
    await waited;
    return responded;
  };
  const request = (path: string, mode = "cors") =>
    ({ url: `${SCOPE}${path}`, mode, method: "GET" }) as Request;
  return {
    caches,
    shown,
    windows,
    opened,
    claimed: () => claimed,
    dispatch,
    request,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  offline = false;
});

const serve = (pages: Record<string, string>) => {
  network = new Map(
    Object.entries(pages).map(([path, body]) => [
      `${SCOPE}${path}`,
      () => new Response(body, { status: 200 }),
    ]),
  );
};

describe("the service worker", () => {
  test("installs this version's files, the page first; another version's page refuses the installation", async () => {
    serve({ "index.html": PAGE, "main-abc.js": "js" });
    const w = await worker();
    await w.dispatch("install", {});
    const store = w.caches.stores.get("oc-v2");
    expect([...(store?.keys() ?? [])].sort()).toEqual([
      `${SCOPE}index.html`,
      `${SCOPE}main-abc.js`,
    ]);

    serve({ "index.html": `<script src="./main-new.js">`, "main-abc.js": "" });
    const other = await worker();
    await expect(other.dispatch("install", {})).rejects.toThrow(
      /another version/,
    );
    expect(other.caches.stores.has("oc-v2")).toBe(false);
  });

  test("activated, the older versions' caches go, the others stay; the page claimed", async () => {
    const w = await worker();
    for (const name of ["oc-v1", "oc-v2", "elsewhere"]) {
      await w.caches.open(name);
    }
    await w.dispatch("activate", {});
    expect(await w.caches.keys()).toEqual(["oc-v2", "elsewhere"]);
    expect(w.claimed()).toBe(1);
  });

  test("the page: the network first, this version's copy offline", async () => {
    serve({ "index.html": PAGE, "main-abc.js": "js" });
    const w = await worker();
    await w.dispatch("install", {});
    serve({ "": "fresh" });
    const online = await w.dispatch("fetch", {
      request: w.request("", "navigate"),
    });
    expect(await online?.text()).toBe("fresh");

    offline = true;
    const kept = await w.dispatch("fetch", {
      request: w.request("", "navigate"),
    });
    expect(await kept?.text()).toBe(PAGE);
  });

  test("the deployment's answers: the network first, the last kept and served offline", async () => {
    serve({ "config.json": `{"gateway":"g"}` });
    const w = await worker();
    const first = await w.dispatch("fetch", {
      request: w.request("config.json"),
    });
    expect(await first?.text()).toBe(`{"gateway":"g"}`);

    offline = true;
    const kept = await w.dispatch("fetch", {
      request: w.request("config.json"),
    });
    expect(await kept?.text()).toBe(`{"gateway":"g"}`);
    const never = await w.dispatch("fetch", {
      request: w.request("revocations"),
    });
    expect(never?.type).toBe("error");
  });

  test("a file of this version: kept on first use, then served from its cache", async () => {
    serve({ "katex-def.js": "katex" });
    const w = await worker();
    const first = await w.dispatch("fetch", {
      request: w.request("katex-def.js"),
    });
    expect(await first?.text()).toBe("katex");
    offline = true;
    const again = await w.dispatch("fetch", {
      request: w.request("katex-def.js"),
    });
    expect(await again?.text()).toBe("katex");
  });

  test("anything else is not intercepted", async () => {
    const w = await worker();
    expect(
      await w.dispatch("fetch", { request: w.request("api/documents") }),
    ).toBeUndefined();
  });

  test("a push message is shown in the browser's language; one it can't read, as a generic one", async () => {
    const w = await worker(["fr-FR"]);
    await w.dispatch("push", { data: { text: () => "not a message" } });
    await w.dispatch("push", {
      data: {
        text: () => {
          throw new Error("unreadable");
        },
      },
    });
    expect(w.shown).toHaveLength(2);
    expect(w.shown[0]?.options.tag).toBe("oc:push");
    expect(w.shown[1]?.title).toBe(w.shown[0]?.title);
    const { t, setLanguage } = await import("../i18n/index.js");
    setLanguage("fr");
    expect(w.shown[0]?.title).toBe(t().pushGenericTitle);
  });

  test("a click brings the document's tab forward, or opens it on this origin", async () => {
    const w = await worker();
    const doc = "a".repeat(32);
    const target = `${SCOPE}?doc=${doc}`;
    let closed = 0;
    const notification = (data: unknown) => ({
      notification: {
        data,
        close: () => {
          closed++;
        },
      },
    });
    await w.dispatch("notificationclick", notification({ doc }));
    expect(w.opened).toEqual([target]);

    w.windows.push({ url: target, focused: 0 });
    await w.dispatch("notificationclick", notification({ doc }));
    expect(w.windows[0]?.focused).toBe(1);
    expect(w.opened).toHaveLength(1);

    // An address in the message is never followed: the page itself.
    await w.dispatch("notificationclick", notification({ doc: "../evil" }));
    expect(w.opened.at(-1)).toBe(SCOPE);
    expect(closed).toBe(3);
  });
});
