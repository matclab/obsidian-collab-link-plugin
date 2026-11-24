/** What a page trusts of its deployment's gateway: the
 * attestation keys `/config.json` names, the revocation list its server
 * serves, and — where this device signs in — the attestation of the key
 * it signs with. Read beside the opening, never before it: a document
 * opens without waiting for its gateway. */
import type { RevocationList } from "../../lib/src/index.js";
import type { IdentityKeys } from "../identity/identity-keys.js";
import type { AccountEnvironment } from "../keyring/environment.js";
import { Attestor, type AttestorState } from "./attestor.js";
import { type PageConfig, readPageConfig } from "./config.js";
import { RevocationReader, type RevocationSource } from "./revocations.js";
import { type AccountState, SignIn } from "./sign-in.js";

/** The page's sign-in, as the question of decision 20 uses it. */
export interface AccountGate {
  state(): AccountState;
  /** In the click; recent if asked (« Confirmer »). */
  start(options?: { recent?: boolean }): void;
  cancel(): void;
  subscribe(listener: () => void): () => void;
  /** Whether the token is recent now (ID-28). */
  recent(): boolean;
}

export interface Trust {
  /** The gateway's origin, if `/config.json` names one. */
  gateway?: string;
  /** The organisation's name. */
  orgName?: string;
  /** The attestation keys configured (ID-26). */
  attestationKeys: ReadonlySet<string>;
  revocations: RevocationSource;
  /** An attestation of `publicKey` valid now, if this page holds one
   * (AT2): written with what it signs (ID-38). */
  attestation(publicKey: Uint8Array): Uint8Array | undefined;
  /** The key the last attestation asked found refused (NK1):
   * the one « Nouvelle clé de signature » replaces. */
  refusedKey(): Uint8Array | undefined;
  /** Gets or renews the attestation (after a sign-in); its state, if
   * this page attests (analysis 18o.2's identity line). */
  refresh(): Promise<AttestorState | undefined>;
  /** Told when the attestation is to be judged again (NK3): a
   * newer revocation list, the keyring's key changed. */
  subscribe(listener: () => void): () => void;
  /** The page's timers. */
  setTimer(run: () => void, ms: number): () => void;
  /** Signing in from this page, where it can (decision 20): once the
   * gateway answered or didn't (3 s at most). */
  account?: Promise<AccountGate | undefined>;
  close(): void;
}

export interface TrustOptions {
  /** Where `/config.json` and `/revocations` are read. */
  apiBase: string;
  /** What the host trusts, instead of `/config.json` (the plugin's
   * settings: analysis 18m, M3). */
  config?: PageConfig;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimer(run: () => void, ms: number): () => void;
  now(): number;
  /** Signing in, where the browser keeps an account. */
  account?: AccountEnvironment;
  identity?: IdentityKeys;
}

/** The page's trust, or none: no attestation key configured. */
export async function openTrust(
  options: TrustOptions,
): Promise<Trust | undefined> {
  const config =
    options.config ?? (await readPageConfig(options.apiBase, options.fetch));
  if (!config.attestationKeys) return undefined;
  const configured = new Set(config.attestationKeys);
  const revocations = new RevocationReader({
    apiBase: options.apiBase,
    configured,
    fetch: options.fetch,
    setTimer: options.setTimer,
  });
  void revocations.read();
  const { account, identity } = options;
  const attestor =
    config.gateway && account && identity
      ? await Attestor.open({
          gateway: config.gateway,
          configured,
          local: account.local,
          fetch: options.fetch,
          now: options.now,
          setTimer: options.setTimer,
          accountSigner: (signed) => identity.accountSigner(signed),
          registrable: (signed, key) => identity.registrable(signed, key),
          revocations,
        })
      : undefined;
  // NK3: what shows the attestation's state judges it again.
  const judging = new Set<() => void>();
  const judgeAgain = () => {
    for (const listener of [...judging]) listener();
  };
  const stopRevocations = revocations.subscribe(judgeAgain);
  const stopKey = identity?.subscribeKey(judgeAgain);
  // Renewed here, if due: a page signs with what it holds meanwhile.
  void attestor?.refresh();
  const listeners = new Set<() => void>();
  let closed = false;
  let wasSignedIn = false;
  const opening =
    config.gateway && account
      ? SignIn.open({
          gateway: config.gateway,
          local: account.local,
          fetch: options.fetch,
          setTimer: options.setTimer,
          now: options.now,
          openWindow: (url) => account.openWindow(url),
          channel: (name) => account.channel(name),
          ...(account.client && { client: account.client }),
          onChange: (state) => {
            for (const listener of [...listeners]) listener();
            // Signed in from this page, or another tab: attested.
            const signedIn = state.kind === "signed-in";
            if (signedIn && !wasSignedIn) void attestor?.refresh();
            wasSignedIn = signedIn;
          },
          // A recent sign-in while no attestation is held.
          recent: () => attestor?.wantsRecent() ?? false,
        }).then(
          (signIn) => {
            if (closed) {
              signIn.close();
              return undefined;
            }
            return signIn;
          },
          () => undefined,
        )
      : undefined;
  return {
    ...(config.gateway && { gateway: config.gateway }),
    ...(config.orgName && { orgName: config.orgName }),
    attestationKeys: configured,
    revocations,
    attestation: (publicKey) => attestor?.envelopeFor(publicKey),
    refresh: async () => attestor?.refresh(),
    refusedKey: () => attestor?.refusedKey(),
    subscribe: (listener) => {
      judging.add(listener);
      return () => judging.delete(listener);
    },
    setTimer: options.setTimer,
    ...(opening && {
      account: opening.then(
        (signIn): AccountGate | undefined =>
          signIn && {
            state: () => signIn.state(),
            start: (options) => signIn.start(options),
            cancel: () => signIn.cancel(),
            recent: () => signIn.recent(),
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
      ),
    }),
    close() {
      closed = true;
      stopRevocations();
      void stopKey?.then((stop) => stop()).catch(() => {});
      judging.clear();
      revocations.close();
      attestor?.close();
      void opening?.then((signIn) => signIn?.close());
    },
  };
}

/** Tells `index` of the keys and of each newer list; the way to stop. */
export function trustIndex(
  trust: Trust,
  index: {
    setAttestationKeys(keys: ReadonlySet<string>): void;
    setRevocations(list: RevocationList | undefined): void;
  },
): () => void {
  index.setAttestationKeys(trust.attestationKeys);
  index.setRevocations(trust.revocations.current());
  return trust.revocations.subscribe(() =>
    index.setRevocations(trust.revocations.current()),
  );
}
