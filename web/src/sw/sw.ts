/** The page's service worker (decisions SW2 to SW4), built
 * into `sw.js` with the manifest of its version. It wires the decisions
 * of `strategy.ts` to the browser's events, nothing more. */
import { chooseLanguage, setLanguage, t } from "../i18n/index.js";
import { clickTarget, shownOf } from "./push.js";
import {
  type Manifest,
  cacheName,
  decide,
  pageMatches,
  staleCaches,
} from "./strategy.js";

/** Written by the build (`build-page.mjs`). */
declare const OC_MANIFEST: Manifest;

// The worker's global scope, as far as this file uses it: the page's
// TypeScript configuration has the DOM's types, not the worker's.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: { data: unknown; close(): void };
}
interface WindowClient {
  url: string;
  focus(): Promise<unknown>;
}
interface WorkerScope {
  registration: {
    scope: string;
    showNotification(
      title: string,
      options: { body: string; tag: string; data: unknown },
    ): Promise<void>;
  };
  clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: "window";
      includeUncontrolled: boolean;
    }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  navigator: { languages: readonly string[] };
  addEventListener(
    type: "install" | "activate",
    listener: (event: ExtendableEvent) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationEvent) => void,
  ): void;
}
const worker = self as unknown as WorkerScope;

const manifest = OC_MANIFEST;
const scope = worker.registration.scope;
const cache = () => caches.open(cacheName(manifest.version));
const at = (path: string) => new URL(path, scope).href;

worker.addEventListener("install", (event) => {
  // No `skipWaiting`: a new version takes effect once every tab of the
  // older one is closed (decision 7).
  event.waitUntil(
    (async () => {
      const store = await cache();
      // The page revalidated; hashed files may come from the HTTP cache.
      await store.add(new Request(at("index.html"), { cache: "no-cache" }));
      await store.addAll(
        manifest.precache.filter((path) => path !== "index.html").map(at),
      );
      const page = await store.match(at("index.html"));
      if (!page || !pageMatches(await page.text(), manifest)) {
        await caches.delete(cacheName(manifest.version));
        throw new Error("the server serves another version: install later");
      }
    })(),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of staleCaches(await caches.keys(), manifest.version)) {
        await caches.delete(name);
      }
      // A first visit's page is controlled at once: reloaded offline, it
      // comes from the cache.
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener("fetch", (event) => {
  const decision = decide(event.request, scope, manifest);
  if (decision.kind === "page") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        // This version's own copy, never one written from the network:
        // it always matches the files of its cache.
        const page = await (await cache()).match(at("index.html"));
        return page ?? Response.error();
      }),
    );
  } else if (decision.kind === "deployment") {
    event.respondWith(
      (async () => {
        const store = await cache();
        try {
          const response = await fetch(event.request);
          if (response.status === 200) {
            await store.put(at(decision.path), response.clone());
          }
          return response;
        } catch {
          // Offline: the last one seen (decision 13); none, the failure.
          return (await store.match(at(decision.path))) ?? Response.error();
        }
      })(),
    );
  } else if (decision.kind === "file") {
    event.respondWith(
      (async () => {
        const store = await cache();
        const kept = await store.match(at(decision.path));
        if (kept) return kept;
        const response = await fetch(event.request);
        // Kept on first use (SW4): KaTeX, Pele, the fonts.
        if (response.ok) await store.put(at(decision.path), response.clone());
        return response;
      })(),
    );
  }
});

// A notification posted by whoever replied (ADR-0060 §3, §5): shown as
// plain text, in the browser's language; a message that isn't one is shown
// as a generic one — a browser shows one anyway.
setLanguage(chooseLanguage(undefined, worker.navigator.languages));
worker.addEventListener("push", (event) => {
  let text: string | undefined;
  try {
    text = event.data?.text();
  } catch {
    text = undefined;
  }
  const shown = shownOf(text, t());
  event.waitUntil(
    worker.registration.showNotification(shown.title, {
      body: shown.body,
      tag: shown.tag,
      data: { doc: shown.doc },
    }),
  );
});

// A click brings the document's tab forward, or opens it on this origin
// (`?doc=`), never an address from the message.
worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { doc } = (event.notification.data ?? {}) as { doc?: string };
  const target = clickTarget(scope, doc);
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const open = windows.find((client) => client.url === target);
      if (open) await open.focus();
      else await worker.clients.openWindow(target);
    })(),
  );
});
