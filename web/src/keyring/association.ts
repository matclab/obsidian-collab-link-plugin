/** The identity and « Mes documents »: after a sign-in,
 * wherever it was made — the home page, a document —, what this device's
 * list is to the identity signed in, and the association itself (KR-44).
 * Asked only when there is something to decide: a list of this device
 * that holds documents, or a list the identity has already (its key
 * needed: end to end, the gateway can't give it). The home page and the
 * document view both use it. */
import type { KeyringEntry } from "../../lib/src/index.js";
import { t } from "../i18n/index.js";
import type { KeyringEnvironment } from "./environment.js";
import { sessionOptions } from "./environment.js";
import { type AccountKeyring, isAccountKeyring } from "./ref.js";
import { KeyringSession, type KeyringStatus } from "./session.js";

/** The identity signed in: its gateway, its provider, its subject. */
export type Identity = Omit<AccountKeyring, "key">;

/** At most this many titles are shown in the question. */
export const TITLES_SHOWN = 5;

export type Situation =
  /** The list here is the identity's. */
  | { kind: "associated" }
  /** The list here is another identity's (TR7): nothing is done until
   * the person chooses; its `count` documents, the first `titles`. */
  | { kind: "other"; identity: Identity; count: number; titles: string[] }
  /** Nothing here to decide, and the identity has no list: associated
   * without a question. */
  | { kind: "automatic" }
  /** The identity has no list, and this device's holds `count`
   * documents, the first `titles` shown. */
  | { kind: "ask"; count: number; titles: string[] }
  /** The identity has a list: to open here, by its key or a code; this
   * device's `count` documents joined then (KR-37). */
  | { kind: "open-here"; count: number }
  /** Not known now: signed out meanwhile, or the gateway out of reach. */
  | { kind: "unknown" };

/** Whether `ref` is `identity`'s list. */
export function ofIdentity(ref: AccountKeyring, identity: Identity): boolean {
  return (
    ref.gateway === identity.gateway &&
    ref.issuer === identity.issuer &&
    ref.sub === identity.sub
  );
}

/** As the list shows it: its title, or « Document sans titre ». */
function titleOf(entry: KeyringEntry): string {
  return entry.title || t().untitled;
}

/** What this device's list (`session`, or none) is to `identity`. The
 * identity's own list is read once, with its token; a list empty here is
 * decided on the copy as it stands now: a document added after is
 * associated with it. */
export async function situation(
  env: KeyringEnvironment,
  apiBase: string,
  session: KeyringSession | undefined,
  identity: Identity,
): Promise<Situation> {
  const ref = session?.ref;
  const entries = session?.entries() ?? [];
  if (ref && isAccountKeyring(ref)) {
    if (ofIdentity(ref, identity)) return { kind: "associated" };
    return {
      kind: "other",
      identity: { gateway: ref.gateway, issuer: ref.issuer, sub: ref.sub },
      count: entries.length,
      titles: entries.slice(0, TITLES_SHOWN).map(titleOf),
    };
  }
  // The identity's list read with a key that opens nothing: only its
  // version is wanted (version 0: none yet).
  const probe = sessionOptions(env, apiBase).transport({
    ...identity,
    key: new Uint8Array(32),
  });
  let read: Awaited<ReturnType<typeof probe.read>>;
  try {
    read = await probe.read();
  } catch {
    // Signed out meanwhile (`SignedOut`), or the gateway out of reach.
    return { kind: "unknown" };
  }
  if (read === "missing" || read.version > 0) {
    return { kind: "open-here", count: entries.length };
  }
  if (entries.length === 0) return { kind: "automatic" };
  return {
    kind: "ask",
    count: entries.length,
    titles: entries.slice(0, TITLES_SHOWN).map(titleOf),
  };
}

/** `ref`'s list becomes this device's (KR-44): the copy here written
 * under the identity — a link's keyring then deleted as KR-29 says.
 * `undefined` if another tab put another list here meanwhile. */
export async function associate(
  env: KeyringEnvironment,
  apiBase: string,
  current: KeyringSession | undefined,
  ref: AccountKeyring,
  onStatus?: (status: KeyringStatus) => void,
  options?: {
    /** Without a question (RA1): only if the copy stored
     * holds no document under the lock; else `undefined`, nothing
     * written. */
    automatic?: boolean;
  },
): Promise<KeyringSession | undefined> {
  if (current && !isAccountKeyring(current.ref)) {
    return KeyringSession.rotate(current, ref, {
      onlyIfEmpty: options?.automatic === true,
    });
  }
  return KeyringSession.adopt(
    sessionOptions(env, apiBase, onStatus),
    ref,
    current?.doc,
    current !== undefined,
  );
}

/** A key for the identity's new list: this device's list's own, or a
 * new one (KR-44). */
export function associationKey(
  current: KeyringSession | undefined,
): Uint8Array {
  return current?.ref.key ?? crypto.getRandomValues(new Uint8Array(32));
}
