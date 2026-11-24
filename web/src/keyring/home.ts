/** The page's home: mounts
 * `Home.svelte` and acts for it on the tab's keyring session. Its parts
 *: what is done with a list's key (`home-key-actions.ts`),
 * the codes between devices (`home-pairing.ts`), the
 * identity and the list it keeps (`home-account.ts`); here, the session they
 * share, its statuses and what
 * the home says, and what awaits my reply. */
import { type ComponentProps, flushSync, mount } from "svelte";
import {
  type CreatedKeyring,
  type PairingAddress,
  bytesToBase64Url,
  keyringIdentity,
} from "../../lib/src/index.js";
import type { PageConfig } from "../account/config.js";
import { t } from "../i18n/index.js";
import { type IdentityKeys, identityKeys } from "../identity/identity-keys.js";
import { PageMe } from "../view-model/page-me.js";
import Home from "./Home.svelte";
import { countAwaiting } from "./awaiting-count.js";
import { startAwaitingRound } from "./awaiting-round.js";
import type { KeyringEnvironment } from "./environment.js";
import { sessionOptions } from "./environment.js";
import { followHomeAccount } from "./home-account.js";
import { homeKeyActions } from "./home-key-actions.js";
import { followHomePairing } from "./home-pairing.js";
import { isAccountKeyring } from "./ref.js";
import { KeyringSession, type KeyringStatus } from "./session.js";

export type { AccountOffer, IdentityStep } from "./home-account.js";
export { PAIRING_SHOWN_MS } from "./home-pairing.js";

export interface HomeOptions {
  apiBase: string;
  /** Absent where this browser keeps nothing on the device. */
  keyring?: KeyringEnvironment;
  createKeyring(): Promise<CreatedKeyring>;
  confirm(message: string): boolean;
  copy(text: string): Promise<void>;
  now(): number;
  /** The address carried a pairing (KR-35), already removed from it
   * (KR-37); `unreadable` if it carried one malformed. */
  pairing?: PairingAddress | "unreadable";
  /** Another host (the plugin, M5): `false`, no « Nouveau
   * document ». */
  newDocument?: boolean;
  /** Opens an entry, instead of following its address. */
  openEntry?(link: string): void;
  /** The gateway and the attestation keys the host trusts, instead of
   * `/config.json` (OB3). */
  config?: PageConfig;
  /** This device's list changed: a new one, joined, associated. */
  onKeyringChanged?(): void;
  /** What awaits my reply in the documents opened most recently, counted
   * from their copies on this device (ADR-0060 §2); absent, nothing. */
  awaiting?: {
    indexedDB: IDBFactory | undefined;
    /** See `storeName`. */
    namespace?: string;
    /** The name I write under, for what isn't signed (ADR-0050 §2). */
    pseudonym(): string;
    /** The page is visible. */
    visible(): boolean;
    onVisible(listener: () => void): () => void;
    setTimer(run: () => void, ms: number): () => void;
  };
}

export interface HomeView {
  /** Resolves once the list stored on this device, if any, is shown. */
  ready: Promise<void>;
  /** Resolves once signing in is shown, or known to be unavailable. */
  accountReady: Promise<void>;
  session(): KeyringSession | undefined;
  close(): void;
}

const mountScreen = (root: HTMLElement, props: ComponentProps<typeof Home>) =>
  mount(Home, { target: root, props });
/** The home's component, as mounted: what it shows (`Home.svelte`). */
export type HomeScreen = ReturnType<typeof mountScreen>;

/** What the home's parts share: the tab's keyring session and what the
 * home says. */
export interface HomeCore {
  readonly options: HomeOptions;
  /** This device's identity keys, for the list's session. */
  readonly keys: IdentityKeys;
  /** The component, once mounted (never called before). */
  screen(): HomeScreen;
  session(): KeyringSession | undefined;
  /** `next` becomes this device's list: shown, and its key attested if
   * it is an account's. */
  use(next: KeyringSession): void;
  /** `current` no longer this device's list: nothing shown in its place;
   * `meanwhile` before it is shown. */
  leave(current: KeyringSession, meanwhile: () => void): void;
  say(text: string, gone?: boolean): void;
  /** What the home says of a session's status. */
  onStatus(status: KeyringStatus): void;
  /** Whether the message shown now is a status. */
  showingStatus(): boolean;
  /** The home busy while `work` runs. */
  busy(work: () => Promise<void>): Promise<void>;
  /** Another tab put a keyring on this device meanwhile: shown, rather
   * than overwritten — its key may exist nowhere else. */
  takenMeanwhile(): Promise<void>;
  closed(): boolean;
  /** Resolves once the list stored here, if any, is open: a situation is
   * judged on it, never before. */
  readonly loaded: Promise<void>;
}

/** What the page says of a session's status, if anything. */
function statusMessage(
  status: KeyringStatus,
): { text: string; gone?: boolean } | undefined {
  switch (status) {
    case "offline":
      return { text: t().keyringOffline };
    case "missing":
      return { text: t().keyringGone, gone: true };
    case "unreadable":
      return { text: t().keyringUnreadableServer };
    case "full":
      return { text: t().keyringFull };
    case "superseded":
      return { text: t().keyringSuperseded };
    case "unsaved":
      return { text: t().keyringUnsaved };
    case "signed-out":
      return { text: t().keyringSignedOut };
    default:
      return undefined;
  }
}

export function mountHome(root: HTMLElement, options: HomeOptions): HomeView {
  root.classList.add("document-view");
  let session: KeyringSession | undefined;
  /** The list stored here being opened: no change of this device's. */
  let openingStored = false;
  const keys = identityKeys({ keyring: async () => session });
  let markLoaded = () => {};
  const loaded = new Promise<void>((resolve) => {
    markLoaded = resolve;
  });
  let unsubscribe = () => {};
  const show = () => {
    view.setKeyring(session !== undefined, session?.entries() ?? []);
    flushSync();
  };
  // Whether the message shown is a status: a status clears only that, not
  // what an action said (« Clé changée… »).
  let showingStatus = false;
  /** The message shown now, by an action or a status. */
  let displayed = "";
  const say = (text: string, gone = false) => {
    displayed = text;
    view.say(text, gone);
  };
  const onStatus = (status: KeyringStatus) => {
    let said = statusMessage(status);
    if (account.silences(status)) said = undefined;
    if (!said && !showingStatus) return;
    // What an action said already says it (TR7's refusal): kept, whatever
    // came first — the status, or the action's answer.
    if (said && displayed.includes(said.text)) return;
    say(said?.text ?? "", said?.gone ?? false);
    showingStatus = said !== undefined;
    flushSync();
  };
  const use = (next: KeyringSession) => {
    unsubscribe();
    session?.close();
    session = next;
    if (!openingStored) options.onKeyringChanged?.();
    // The list's key changed (another device replaced it): attested
    // again (NK3).
    const keyOf = () => {
      const held = keyringIdentity(next.doc);
      return held ? bytesToBase64Url(held.publicKey) : "";
    };
    let key = keyOf();
    unsubscribe = next.subscribe(() => {
      show();
      const now = keyOf();
      if (now === key) return;
      key = now;
      if (isAccountKeyring(next.ref)) void account.attest();
    });
    // What was found for the list before is no longer said (IC3).
    account.forgetAttestation();
    show();
    account.refresh();
    // An account's list opened, or attached (KR-44): its key attested.
    if (isAccountKeyring(next.ref)) void account.attest();
  };
  const busy = async (work: () => Promise<void>) => {
    view.setBusy(true);
    flushSync();
    try {
      await work();
    } finally {
      view.setBusy(false);
      flushSync();
    }
  };
  const takenMeanwhile = async () => {
    if (!options.keyring) return;
    const opened = await KeyringSession.open(
      sessionOptions(options.keyring, options.apiBase, onStatus),
    );
    if (opened) use(opened);
  };
  let closed = false;
  const core: HomeCore = {
    options,
    keys,
    screen: () => view,
    session: () => session,
    use,
    leave: (current, meanwhile) => {
      unsubscribe();
      unsubscribe = () => {};
      current.close();
      session = undefined;
      meanwhile();
      show();
    },
    say,
    onStatus,
    showingStatus: () => showingStatus,
    busy,
    takenMeanwhile,
    closed: () => closed,
    loaded,
  };
  const account = followHomeAccount(core, {
    signedIn: () => pairing.signedIn(),
    endPairing: () => pairing.end(),
  });
  const pairing = followHomePairing(core, account);
  const keyActions = homeKeyActions(core, pairing);

  const view = mountScreen(root, {
    ...(options.newDocument !== false && { newDocumentHref: "?new" }),
    ...(options.openEntry && { onOpenEntry: options.openEntry }),
    available: options.keyring !== undefined,
    ...keyActions,
    onCopy: (text: string) => void options.copy(text),
    ...pairing.props,
    ...account.props,
  });
  flushSync();

  const accountReady = account.start();

  const ready = (async () => {
    try {
      if (!options.keyring) return;
      if (options.pairing && (await pairing.pair(options.pairing))) return;
      const opened = await KeyringSession.open(
        sessionOptions(options.keyring, options.apiBase, onStatus),
      );
      if (opened) {
        openingStored = true;
        use(opened);
        openingStored = false;
      }
    } finally {
      markLoaded();
    }
  })();
  // What awaits my reply, once the list is open (ADR-0060 §2).
  let stopRound = () => {};
  const counting = options.awaiting;
  if (counting) {
    void ready.then(() => {
      if (closed) return;
      const me = new PageMe(counting.pseudonym());
      const round = startAwaitingRound({
        entries: () => session?.entries() ?? [],
        count: async (entry, stopped) => {
          // Who I am, as it stands: my keys, the account signed in.
          me.setPseudonym(counting.pseudonym());
          me.setKeys(await keys.fingerprints());
          const accountState = account.state();
          me.setAccount(
            accountState.kind === "signed-in"
              ? { issuer: accountState.issuer, sub: accountState.sub }
              : undefined,
          );
          return countAwaiting(
            entry,
            {
              indexedDB: counting.indexedDB,
              ...(counting.namespace && { namespace: counting.namespace }),
              me,
              setTimer: counting.setTimer,
            },
            stopped,
          );
        },
        shown: (documentId, count) => {
          view.setAwaiting(documentId, count);
          flushSync();
        },
        visible: counting.visible,
        onVisible: counting.onVisible,
        setTimer: counting.setTimer,
        now: options.now,
      });
      stopRound = () => round.stop();
    });
  }
  return {
    ready,
    accountReady,
    session: () => session,
    close() {
      closed = true;
      stopRound();
      account.close();
      pairing.end();
      unsubscribe();
      session?.close();
    },
  };
}
