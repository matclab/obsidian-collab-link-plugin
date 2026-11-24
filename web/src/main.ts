import "./styles/page-only.css";
import {
  createDocument,
  createKeyring,
  documentLinks,
} from "../lib/src/index.js";
import { readPageConfig } from "./account/config.js";
import { browserAttention } from "./app/browser-attention.js";
import { openDocument } from "./app/open-document.js";
import { startPage } from "./app/page.js";
import { registerServiceWorker } from "./app/service-worker.js";
import type { KeyringEnvironment } from "./keyring/environment.js";
import { openKeyringLocal, webKeyringLock } from "./keyring/local.js";
import { browserDevicePush } from "./push/browser-push.js";
import { type DocumentLock, webLocks } from "./storage/index.js";

/** `localStorage`, or nothing where the browser refuses it. */
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** IndexedDB, or nothing where the browser refuses it. */
function browserIndexedDB(): IDBFactory | undefined {
  try {
    return window.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

/** The Web Locks lock, where the browser has it (secure contexts). */
function browserLock(): DocumentLock | undefined {
  return navigator.locks ? webLocks(navigator.locks) : undefined;
}

/** « Mes documents »: where IndexedDB and Web Locks are. */
function browserKeyring(): KeyringEnvironment | undefined {
  const indexedDB = browserIndexedDB();
  if (!indexedDB || !navigator.locks) return undefined;
  const local = openKeyringLocal({
    indexedDB,
    lock: webKeyringLock(navigator.locks),
  });
  return {
    local,
    fetch: (url, init) => fetch(url, init),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    // Signing in (ADR-0041): the window, and the channels of the origin.
    ...(typeof BroadcastChannel === "function" && {
      account: {
        local,
        openWindow: (url: string) =>
          void window.open(url, "oc-sign-in", "popup,width=480,height=640"),
        channel: (name: string) => {
          const channel = new BroadcastChannel(name);
          return {
            post: (data: unknown) => channel.postMessage(data),
            listen: (listener: (data: unknown) => void) => {
              const handle = (event: MessageEvent) => listener(event.data);
              channel.addEventListener("message", handle);
              return () => channel.removeEventListener("message", handle);
            },
          };
        },
      },
    }),
  };
}

const keyring = browserKeyring();

startPage({
  root: document.body,
  location: () => window.location,
  replaceAddress: (url) => window.history.replaceState(null, "", url),
  reload: () => window.location.reload(),
  storage: browserStorage(),
  indexedDB: browserIndexedDB(),
  lock: browserLock(),
  languages: navigator.languages,
  online: () => navigator.onLine,
  window,
  confirm: (message) => window.confirm(message),
  copy: (text) => navigator.clipboard.writeText(text),
  registerServiceWorker: () => registerServiceWorker(),
  createDocument: (apiBase) => createDocument(apiBase),
  ...(keyring && { keyring }),
  createKeyring: (apiBase) => createKeyring(apiBase),
  now: () => Date.now(),
  fetch: (url, init) => fetch(url, init),
  objectUrls: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  attachmentLimits: () =>
    readPageConfig(window.location.origin, fetch).then(
      (config) => config.attachments,
    ),
  pushKey: (apiBase) =>
    readPageConfig(apiBase, fetch).then((config) => config.push?.vapidKey),
  ...(() => {
    const devicePush = browserDevicePush(
      navigator.serviceWorker,
      typeof PushManager === "function",
    );
    return devicePush ? { devicePush } : {};
  })(),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  documentLinks,
  openDocument,
  mac: /Mac|iPhone|iPad|iPod/.test(navigator.platform),
  attention: browserAttention({
    window,
    document,
    ...(typeof Notification === "function" && { Notification }),
  }),
}).catch((error: unknown) => {
  console.error(error);
});
