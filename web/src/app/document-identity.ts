import type { CreatedKeyring } from "../../lib/src/index.js";
import type { PageConfig } from "../account/config.js";
/** What a document view is given of « Mes documents » and of the
 * identity (M7): the keyring's hooks, the key it
 * signs with, the trust of the gateway, the association of a sign-in,
 * the name signed in. The page builds it for its tab, the plugin for each
 * of its views, both from here. */
import { type Trust, openTrust } from "../account/trust.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import { DocumentAssociation } from "../keyring/document-association.js";
import type { KeyringEnvironment } from "../keyring/environment.js";
import { documentKeyring } from "../keyring/hooks.js";
import type { KeyringSession } from "../keyring/session.js";
import type { DocumentTarget } from "./document-view.js";

export interface DocumentIdentityOptions {
  /** The document's server. */
  apiBase: string;
  documentId: string;
  /** Created here, now (KR-24). */
  created: boolean;
  now(): number;
  /** The keyring of this tab, or of the vault, as it is now. */
  session(): Promise<KeyringSession | undefined>;
  /** An association replaced it. */
  replaceSession(next: KeyringSession): void;
  keyring?: KeyringEnvironment;
  /** A keyring at the server, for the list in waiting of a sign-in whose
   * list is elsewhere (LA1). */
  createKeyring?(): Promise<CreatedKeyring>;
  /** Omitted: nothing is signed (no Ed25519, nowhere to keep a key). */
  identity?: IdentityKeys;
  /** The network and the timers; absent, nothing is attested. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  setTimer?(run: () => void, ms: number): () => void;
  /** What the host trusts, and the server it reads revocations from,
   * instead of the document's `/config.json` (the plugin: M3). */
  trusted?: { config: PageConfig; apiBase: string };
}

export function documentIdentity(
  options: DocumentIdentityOptions,
): Pick<
  DocumentTarget,
  "keyring" | "identity" | "trust" | "association" | "signedInName"
> {
  const { identity, fetch, setTimer } = options;
  const trust: Promise<Trust | undefined> | undefined =
    fetch && setTimer
      ? openTrust({
          apiBase: options.trusted?.apiBase ?? options.apiBase,
          ...(options.trusted && { config: options.trusted.config }),
          fetch,
          setTimer,
          now: () => options.now(),
          ...(options.keyring?.account && { account: options.keyring.account }),
          ...(identity && { identity }),
        }).catch(() => undefined)
      : undefined;
  // The identity and « Mes documents »: a sign-in here
  // associates the list as the home page does.
  const keyringEnv = options.keyring;
  const keyring = documentKeyring(() => options.session(), options.documentId, {
    created: options.created,
    now: () => options.now(),
  });
  const association =
    trust && keyringEnv?.account
      ? trust.then(async (read) => {
          const gate = await read?.account;
          if (!read?.gateway || !gate) return undefined;
          return new DocumentAssociation({
            env: keyringEnv,
            apiBase: options.apiBase,
            gateway: read.gateway,
            gate,
            session: () => options.session(),
            replace: (next) => {
              options.replaceSession(next);
              // What the view noted, perhaps in no list (LA2).
              void keyring.again().catch(() => {});
            },
            ...(options.createKeyring && {
              createKeyring: options.createKeyring,
            }),
            refresh: async () => {
              await read.refresh();
            },
          });
        })
      : undefined;
  const account = keyringEnv?.account;
  return {
    keyring,
    // The keyring's key if there is one, else this device's (decision 8).
    ...(identity && { identity }),
    ...(trust && { trust }),
    ...(association && { association }),
    ...(account && {
      signedInName: async () => {
        const signed = await account.local.signedIn().catch(() => undefined);
        return signed && signed.deadline > options.now()
          ? signed.name
          : undefined;
      },
    }),
  };
}
