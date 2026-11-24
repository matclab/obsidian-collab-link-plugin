/** The home's codes (KR-35 – KR-43): one shown
 * to add a device, its deposit at the server or, for an account's list,
 * at the gateway; one taken, here or once signed in, and its keyring
 * joined to this device's copy. Acts on the home's session through
 * `HomeCore`. */
import { flushSync } from "svelte";
import {
  type KeyringCredentials,
  type PairingAddress,
  SignedOut,
  depositAccountPairing,
  depositPairing,
  formatKeyringLink,
  formatPairingAddress,
  newPairingKey,
  openAccountPairing,
  openPairing,
  readPairingAddress,
  sealAccountPairing,
  sealPairing,
  takeAccountPairing,
  takePairing,
} from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import { accountToken, sessionOptions } from "./environment.js";
import type { HomeAccount } from "./home-account.js";
import type { HomeCore } from "./home.js";
import { qrCode } from "./qr.js";
import {
  type AccountKeyring,
  type KeyringRef,
  isAccountKeyring,
  linkOf,
  otherAccounts,
} from "./ref.js";
import { KeyringSession } from "./session.js";

/** How long the page shows a code (KR-31): the server keeps the deposit
 * as long, by its own clock. */
export const PAIRING_SHOWN_MS = 300_000;

/** A pairing address of this server in `text`, if it is one (KR-35). */
export function pairingIn(
  text: string,
  apiBase: string,
): PairingAddress | "unreadable" | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(apiBase).origin) return undefined;
  try {
    return readPairingAddress(url.search, url.hash);
  } catch {
    return "unreadable";
  }
}

export interface HomePairing {
  /** Takes the deposit and joins its keyring to this device's copy
   * (KR-36, KR-37); `false` if it couldn't, said why. */
  pair(pairing: PairingAddress | "unreadable"): Promise<boolean>;
  /** Signed in: an account's pairing that waited is taken (KR-43). */
  signedIn(): void;
  /** Hides the code shown, and its timer. */
  end(): void;
  readonly props: { onAddDevice(): void; onPairingDone(): void };
}

export function followHomePairing(
  core: HomeCore,
  account: Pick<HomeAccount, "signed" | "joined">,
): HomePairing {
  const { options } = core;
  /** An account's pairing that waits for a sign-in (KR-43). */
  let pendingPairing: PairingAddress | undefined;
  /** Hides the code shown, and its timer. */
  let endPairing = () => {};
  const addDevice = () =>
    core.busy(async () => {
      const current = core.session();
      const env = options.keyring;
      if (!current || !env) return;
      endPairing();
      const key = newPairingKey();
      const fetchFn = (url: string, init?: RequestInit) => env.fetch(url, init);
      const ref = current.ref;
      // An account's list: deposited at the gateway, given only to the
      // same account (KR-41, KR-43).
      const accountEnv = isAccountKeyring(ref) ? env.account : undefined;
      let deposited: Awaited<ReturnType<typeof depositPairing>>;
      try {
        deposited =
          isAccountKeyring(ref) && accountEnv
            ? await depositAccountPairing(
                ref.gateway,
                () => accountToken(accountEnv.local, ref),
                await sealAccountPairing(key, ref.key),
                fetchFn,
              )
            : await depositPairing(
                options.apiBase,
                linkOf(ref),
                await sealPairing(key, formatKeyringLink(linkOf(ref))),
                fetchFn,
              );
      } catch (error) {
        core.say(
          error instanceof SignedOut ? t().addDeviceSignIn : t().keyringOffline,
        );
        flushSync();
        return;
      }
      if (deposited === "missing") {
        core.onStatus("missing");
        return;
      }
      if (deposited === "too-many") {
        core.say(t().pairingTooMany);
        flushSync();
        return;
      }
      const address = formatPairingAddress(
        options.apiBase,
        deposited.pairingId,
        key,
        { account: isAccountKeyring(ref) },
      );
      const view = core.screen();
      view.showPairing({ address, ...qrCode(address) });
      flushSync();
      const cancel = env.setTimer(() => {
        view.pairingExpired();
        flushSync();
      }, PAIRING_SHOWN_MS);
      endPairing = () => {
        cancel();
        endPairing = () => {};
        view.showPairing(undefined);
        flushSync();
      };
    });

  /** Joins the keyring `ref` handed over by another device to this
   * device's copy (KR-37, KR-43); `false` if it couldn't, said why. */
  const joinGiven = async (ref: KeyringRef) => {
    const env = options.keyring;
    if (!env) return false;
    const fail = (text: string) => {
      core.say(text);
      flushSync();
      return false;
    };
    const join = (merge: boolean) =>
      KeyringSession.join(
        sessionOptions(env, options.apiBase, core.onStatus),
        ref,
        merge,
      );
    // TR7: an account's list here never joins another account's: not
    // even asked (`local.join` refuses it anyway).
    const here = (await env.local.load())?.ref;
    // The list here is another account's than the one signed in: kept,
    // and not synchronised — both said, in either order with the status.
    if (here && otherAccounts(here, ref)) {
      return fail(`${t().pairingKeptOwn} ${t().keyringOtherAccount}`);
    }
    let joined = await join(false);
    // Another list here: given to the code's only if its user agrees
    // (security review of 18f) — a code is an address anyone can send.
    if (joined.was === "other") {
      if (!options.confirm(t().pairingMergeConfirm))
        return fail(t().pairingKeptOwn);
      joined = await join(true);
    }
    if (!joined.session) return fail(t().pairingKeptOwn);
    const { was } = joined;
    account.joined();
    core.use(joined.session);
    core.say(
      was === "merged"
        ? `${t().pairingJoined} ${t().pairingMerged}`
        : t().pairingJoined,
    );
    flushSync();
    return true;
  };

  /** An account's deposit, taken with the token of the account signed
   * in (KR-41, KR-43): given only to the same account. */
  const pairAccount = async () => {
    const env = options.keyring;
    const signed = account.signed();
    const pairing = pendingPairing;
    if (!env?.account || !signed || !pairing) return;
    pendingPairing = undefined;
    const accountEnv = env.account;
    const fail = (text: string) => {
      core.say(text);
      flushSync();
    };
    let deposit: Uint8Array | "missing";
    try {
      deposit = await takeAccountPairing(
        signed.gateway,
        () => accountToken(accountEnv.local, signed),
        pairing.pairingId,
        (url, init) => env.fetch(url, init),
      );
    } catch (error) {
      if (error instanceof SignedOut) pendingPairing = pairing;
      return fail(
        error instanceof SignedOut
          ? t().pairingSignInFirst
          : t().keyringOffline,
      );
    }
    if (deposit === "missing") return fail(t().pairingGone);
    let key: Uint8Array;
    try {
      key = await openAccountPairing(pairing.key, deposit);
    } catch {
      return fail(t().pairingUnreadable);
    }
    await joinGiven({ ...signed, key } satisfies AccountKeyring);
  };

  const pair = async (pairing: PairingAddress | "unreadable") => {
    const env = options.keyring;
    if (!env) return false;
    const fail = (text: string) => {
      core.say(text);
      flushSync();
      return false;
    };
    if (pairing === "unreadable") return fail(t().pairingUnreadable);
    if (pairing.account) {
      // The account's own: taken once signed in (KR-43).
      pendingPairing = pairing;
      if (account.signed()) void pairAccount();
      else fail(t().pairingSignInFirst);
      return false;
    }
    let deposit: Uint8Array | "missing";
    try {
      deposit = await takePairing(
        options.apiBase,
        pairing.pairingId,
        (url, init) => env.fetch(url, init),
      );
    } catch {
      return fail(t().keyringOffline);
    }
    if (deposit === "missing") return fail(t().pairingGone);
    let credentials: KeyringCredentials;
    try {
      credentials = await openPairing(pairing.key, deposit);
    } catch {
      return fail(t().pairingUnreadable);
    }
    return joinGiven(credentials);
  };

  return {
    pair,
    signedIn: () => {
      if (pendingPairing) void pairAccount();
    },
    end: () => endPairing(),
    props: {
      onAddDevice: () => void addDevice(),
      onPairingDone: () => endPairing(),
    },
  };
}
