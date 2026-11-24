import {
  type LinkFragment,
  type PairingAddress,
  type createDocument,
  type createKeyring,
  parseLinkFragment,
  readPairingAddress,
} from "../../lib/src/index.js";
import { LANGUAGE_KEY, chooseLanguage, setLanguage, t } from "../i18n/index.js";
import { identityKeys, openDeviceKeyStore } from "../identity/identity-keys.js";
import { PSEUDONYM_KEY } from "../identity/pseudonym.js";
import {
  type KeyringEnvironment,
  sessionOptions,
} from "../keyring/environment.js";
import { mountHome } from "../keyring/home.js";
import { KeyringSession } from "../keyring/session.js";
import { documentIdentity } from "./document-identity.js";
import {
  type DocumentViewEnvironment,
  createViewFrame,
  mountDocumentView,
  noticeShower,
} from "./document-view.js";
import { isKeyless, linkFromList, withoutHeading } from "./keyless.js";

/** What the page takes from the browser, and the calls whose timing a test
 * controls (`page.property.test.ts`): `main.ts` passes the real ones. */
export interface PageEnvironment extends DocumentViewEnvironment {
  /** Where the page's view goes: its body. */
  root: HTMLElement;
  /** The page's address, read when needed: replaced after a creation or a
   * rotation. */
  location(): { href: string; origin: string; search: string; hash: string };
  replaceAddress(url: string): void;
  languages: readonly string[];
  registerServiceWorker(): Promise<void>;
  createDocument: (apiBase: string) => ReturnType<typeof createDocument>;
  /** « Mes documents »: absent where this browser keeps
   * nothing on the device. */
  keyring?: KeyringEnvironment;
  createKeyring: (apiBase: string) => ReturnType<typeof createKeyring>;
  /** The wall clock, in milliseconds. */
  now(): number;
  /** The network and the timers, for what the page trusts of its
   * gateway; absent, nothing is attested. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  setTimer?(run: () => void, ms: number): () => void;
}

/** Opens the page: the document of the address (`?doc=`), a new one
 * (`?new`), or the home, which takes the code of
 * another device (`?pair=`). What depends on the
 * address is here; the views themselves, `mountDocumentView` and
 * `mountHome`. */
export async function startPage(env: PageEnvironment): Promise<void> {
  // Before anything is shown.
  setLanguage(
    chooseLanguage(env.storage?.getItem(LANGUAGE_KEY), env.languages),
    env.root.ownerDocument.documentElement,
  );
  // The binary serves the page: the server is its origin (K-3).
  const apiBase = env.location().origin;

  const params = new URLSearchParams(env.location().search);
  let documentId = params.get("doc");
  if (!documentId && !params.has("new")) {
    // A code from another device (KR-35): its key leaves the address
    // before anything else (KR-37).
    let pairing: PairingAddress | "unreadable" | undefined;
    try {
      pairing = readPairingAddress(env.location().search, env.location().hash);
    } catch {
      pairing = "unreadable";
    }
    if (pairing) env.replaceAddress(new URL("/", apiBase).href);
    const home = mountHome(env.root, {
      ...(pairing && { pairing }),
      apiBase,
      ...(env.keyring && { keyring: env.keyring }),
      createKeyring: () => env.createKeyring(apiBase),
      confirm: (message) => env.confirm(message),
      copy: (text) => env.copy(text),
      now: () => env.now(),
      // What awaits my reply in the recent documents (ADR-0060 §2), while
      // the page is looked at.
      ...(env.attention &&
        env.setTimer && {
          awaiting: {
            indexedDB: env.indexedDB,
            pseudonym: () => env.storage?.getItem(PSEUDONYM_KEY) ?? "",
            visible: () => env.attention?.watched() ?? false,
            onVisible: (listener: () => void) =>
              env.attention?.subscribe(listener) ?? (() => {}),
            setTimer: (run: () => void, ms: number) =>
              env.setTimer?.(run, ms) ?? (() => {}),
          },
        }),
    });
    await home.ready;
    void env.registerServiceWorker();
    return;
  }
  const frame = createViewFrame(env.root);
  const showNotice = noticeShower(frame, () => env.reload());
  // The keyring of this device, if any, in step in the background: the
  // document doesn't wait for it, only a rotation does (TR2).
  let session = env.keyring
    ? KeyringSession.open(sessionOptions(env.keyring, apiBase)).catch(
        (error: unknown) => {
          console.warn("keyring", error);
          return undefined;
        },
      )
    : Promise.resolve(undefined);
  let link: LinkFragment;
  let created = false;

  // A heading to go to once open (ADR-0045 §2), never kept in the address.
  const { href, heading } = withoutHeading(env.location().href);
  if (documentId) {
    if (isKeyless(env.location().hash)) {
      // An address that names a document without its key: its link from « Mes
      // documents ».
      const answer = await linkFromList(await session, documentId, apiBase);
      if (answer.kind !== "found") {
        showNotice(KEYLESS[answer.kind]());
        return;
      }
      env.replaceAddress(answer.link);
    } else if (href !== env.location().href) env.replaceAddress(href);
    try {
      link = parseLinkFragment(env.location().hash);
    } catch {
      showNotice(t().invalidLink);
      return;
    }
  } else {
    let createdDocument: Awaited<ReturnType<typeof createDocument>>;
    try {
      createdDocument = await env.createDocument(apiBase);
    } catch (error) {
      // Offline, the page itself may come from the service worker (SW6).
      showNotice(t().createNeedsServer);
      throw error;
    }
    documentId = createdDocument.documentId;
    const links = await env.documentLinks(
      env.location().href,
      documentId,
      createdDocument.keyMaterial,
      createdDocument.editSecret,
    );
    link = parseLinkFragment(new URL(links.edit).hash);
    env.replaceAddress(links.edit);
    created = true;
  }
  const identity = identityKeys({
    ...(env.indexedDB && {
      device: openDeviceKeyStore(env.indexedDB, env.localNamespace),
    }),
    keyring: () => session,
  });
  const mounted = await mountDocumentView(
    env.root,
    env,
    {
      apiBase,
      documentId,
      link,
      linkBase: () => env.location().href,
      onEditLink: (links) => env.replaceAddress(links.edit),
      // Once opened, not to compete with opening (SW5).
      onOpened: () => void env.registerServiceWorker(),
      // `?perf`: named measures in the DevTools Performance panel, and a
      // summary of the opening in the console (docs/phase-4ter-*.md, step 1).
      perf: params.has("perf"),
      // `?trace` records a replayable scenario trace of this tab (trace/).
      trace: params.has("trace"),
      welcome: true,
      ...documentIdentity({
        apiBase,
        documentId,
        created,
        now: () => env.now(),
        session: () => session,
        replaceSession: (next) => {
          session = Promise.resolve(next);
        },
        ...(env.keyring && { keyring: env.keyring }),
        createKeyring: () => env.createKeyring(apiBase),
        identity,
        ...(env.fetch && { fetch: env.fetch.bind(env) }),
        ...(env.setTimer && { setTimer: env.setTimer.bind(env) }),
      }),
    },
    frame,
  );
  if (heading) mounted.anchor?.(heading);
}

/** What the page says of an address without a key it can't open. */
const KEYLESS = {
  "no-list": () => t().keylessNoList,
  absent: () => t().keylessAbsent,
  unchecked: () => t().keylessUnchecked,
} as const;
