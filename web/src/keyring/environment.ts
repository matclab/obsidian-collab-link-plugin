/** What the keyring takes from the page (`PageEnvironment.keyring`): the
 * device's copy, the network, the timers. Absent where the browser keeps
 * nothing (no IndexedDB, no locks): then no « Mes documents ». */
import {
  deleteKeyring,
  httpAccountKeyringTransport,
  httpKeyringTransport,
} from "../../lib/src/index.js";
import type { AccountChannel } from "../account/sign-in.js";
import type { AccountLocal, KeyringLocal } from "./local.js";
import { type AccountKeyring, isAccountKeyring } from "./ref.js";
import type { KeyringSessionOptions, KeyringStatus } from "./session.js";

export interface KeyringEnvironment {
  local: KeyringLocal;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimer(run: () => void, ms: number): () => void;
  /** Signing in: absent where the browser has no
   * `BroadcastChannel`. */
  account?: AccountEnvironment;
}

/** What signing in takes from the page, besides the network and the
 * timers: the account kept on this device, the window, the channels. */
export interface AccountEnvironment {
  local: AccountLocal;
  openWindow(url: string): void;
  channel(name: string): AccountChannel;
  /** Outside a browser: the return by `obsidian://` (ID-41). */
  client?: "obsidian";
}

/** The token kept on this device, if it is of `ref`'s gateway and
 * account (KR-44, TR7): another account's is never sent for this list. */
export async function accountToken(
  local: AccountLocal,
  ref: Omit<AccountKeyring, "key">,
): Promise<string | undefined> {
  const kept = await local.signedIn();
  const same =
    kept !== undefined &&
    kept.gateway === ref.gateway &&
    kept.issuer === ref.issuer &&
    kept.sub === ref.sub;
  return same ? kept.token : undefined;
}

export function sessionOptions(
  env: KeyringEnvironment,
  apiBase: string,
  onStatus?: (status: KeyringStatus) => void,
): KeyringSessionOptions {
  const fetchFn = (url: string, init?: RequestInit) => env.fetch(url, init);
  return {
    local: env.local,
    // An account's keyring with the token of the moment, read at each
    // request: none here, it is `SignedOut`.
    transport: (ref) =>
      isAccountKeyring(ref)
        ? httpAccountKeyringTransport(
            ref.gateway,
            async () =>
              env.account ? accountToken(env.account.local, ref) : undefined,
            fetchFn,
          )
        : httpKeyringTransport(apiBase, ref, fetchFn),
    remove: (credentials) => deleteKeyring(apiBase, credentials, fetchFn),
    setTimer: (run, ms) => env.setTimer(run, ms),
    ...(onStatus && { onStatus }),
  };
}
