/** The home's identity: the configuration read, the revocations and the
 * attestation of
 * the list's key, signing in; what this device's list is to the identity
 * signed in, decided and acted on — associated, asked, its key asked,
 * started over. Acts on the home's session through `HomeCore`. */
import { flushSync } from "svelte";
import { parseAccountKey } from "../../lib/src/index.js";
import { Attestor, type AttestorState } from "../account/attestor.js";
import { readPageConfig } from "../account/config.js";
import { RevocationReader } from "../account/revocations.js";
import { type AccountState, SignIn } from "../account/sign-in.js";
import { t } from "../i18n/index.js";
import {
  type Situation,
  associate,
  associationKey,
  situation,
} from "./association.js";
import { sessionOptions } from "./environment.js";
import type { HomeCore } from "./home.js";
import { type AccountKeyring, isAccountKeyring, keyText } from "./ref.js";
import { KeyringSession, type KeyringStatus } from "./session.js";

/** What the list offers the identity signed in. */
export type AccountOffer =
  | { kind: "none" }
  /** « Associer ces N documents à votre identité … ? », or, once
   * « Plus tard » answered, a quiet offer. */
  | { kind: "ask"; count: number; titles: string[]; later: boolean }
  /** The identity has a list: its key, or a code, opens it here. */
  | { kind: "needs-key" }
  /** This browser's list is another identity's (`name`, if known here):
   * associated with the one signed in, not kept here, or sign out. */
  | { kind: "other"; count: number; titles: string[]; name?: string };

/** The list is the identity's, and its name not carried yet (IC3): the identity
 * to confirm, not confirmed (the gateway out of
 * reach), or the key refused. */
export type IdentityStep = "confirm" | "unconfirmed" | "refused";

/** The step an attestation's answer leaves, the list the identity's. */
function stepOf(found: AttestorState | undefined): IdentityStep | undefined {
  switch (found) {
    case "needs-recent":
      return "confirm";
    case "unattested":
      return "unconfirmed";
    case "refused":
      return "refused";
    default:
      return undefined;
  }
}

export interface HomeAccount {
  /** Reads the configuration, then the attestation and signing in: once
   * the home is mounted. Resolves once signing in is shown, or known to
   * be unavailable. */
  start(): Promise<void>;
  /** The account signed in on this device, if any. */
  signed(): Omit<AccountKeyring, "key"> | undefined;
  state(): AccountState;
  /** What the list offers the identity, and the step left, shown. */
  refresh(): void;
  /** The attestation got or renewed, and what it found shown (IC3). */
  attest(): Promise<void>;
  /** A new list here: what was found for the one before is no longer
   * said (IC3). */
  forgetAttestation(): void;
  /** The session's status, an account's list here: `true` if the home
   * says it otherwise (its key asked, TR7's choices), not as a status. */
  silences(status: KeyringStatus): boolean;
  /** A list joined here (KR-37): its key is no longer asked for. */
  joined(): void;
  /** What the home's component calls for the identity. */
  readonly props: {
    onSignIn(): void;
    onCancelSignIn(): void;
    onSignOut(): void;
    onAttach(): void;
    onLater(): void;
    onAssociateOther(): void;
    onConfirmIdentity(): void;
    onRetryIdentity(): void;
    onNewSigningKey(): void;
    onForgetOther(): void;
    onAccountKey(text: string): void;
    onStartOver(): void;
  };
  close(): void;
}

export function followHomeAccount(
  core: HomeCore,
  hooks: {
    /** Signed in: an account's pairing that waited is taken (KR-43). */
    signedIn(): void;
    /** A code shown carries the list replaced. */
    endPairing(): void;
  },
): HomeAccount {
  const { options, keys } = core;
  /** Signing in, where the page has a gateway. */
  let signIn: SignIn | undefined;
  /** The attestation of the account keyring's key, where
   * the page trusts attestation keys. */
  let attestor: Attestor | undefined;
  /** The revocation list (ID-40), read beside the attestor (NK2). */
  let revocations: RevocationReader | undefined;
  let gateway: string | undefined;
  /** The organisation's name (`/config.json`): « Identité <name> ». */
  let orgName: string | undefined;
  let accountState = { kind: "unavailable" } as AccountState;
  /** What the situation after the last sign-in asks. */
  let asked: Extract<AccountOffer, { kind: "ask" | "other" }> | undefined;
  /** The account has a list: its key is asked for (KR-44). */
  let needsKey = false;
  /** What the last attestation asked found (IC3). */
  let attestation: AttestorState | undefined;
  /** The latest attestation asked only. */
  let attesting = 0;
  /** A recent sign-in this page opened to confirm the identity (IC2):
   * meanwhile the identity stays the one signed in, for its logic. */
  let confirming = false;
  /** « Recommencer une liste » agreed, waiting for its recent sign-in
   * (RL1). */
  let startingOver = false;
  /** The account signed in on this device, if any. */
  const signedAccount = (): Omit<AccountKeyring, "key"> | undefined =>
    accountState.kind === "signed-in" && gateway
      ? { gateway, issuer: accountState.issuer, sub: accountState.sub }
      : undefined;
  /** Whether `ref` is the signed-in account's (TR7). */
  const ofSigned = (ref: AccountKeyring) => {
    const signed = signedAccount();
    return (
      signed !== undefined &&
      ref.gateway === signed.gateway &&
      ref.issuer === signed.issuer &&
      ref.sub === signed.sub
    );
  };
  /** « votre identité Systerel, Ada Lovelace (ada@…) ». */
  const identityText = () =>
    accountState.kind === "signed-in"
      ? t().yourIdentity(
          orgName,
          t().identityWho(accountState.name, accountState.email),
        )
      : "";
  /** What the list offers the identity signed in. */
  const refreshAccount = () => {
    const ref = core.session()?.ref;
    const accountList = ref !== undefined && isAccountKeyring(ref);
    let offer: AccountOffer = { kind: "none" };
    if (signedAccount() && options.keyring?.account) {
      if (!accountList) {
        if (needsKey) offer = { kind: "needs-key" };
        else if (asked) offer = asked;
      } else if (ofSigned(ref) && needsKey) offer = { kind: "needs-key" };
      else if (!ofSigned(ref)) {
        if (needsKey) offer = { kind: "needs-key" };
        else if (asked?.kind === "other") offer = asked;
      }
    }
    const view = core.screen();
    view.setAccountList(offer, accountList, identityText());
    // The step left once the list is the identity's (IC3).
    const step =
      accountList && ofSigned(ref) && !needsKey
        ? stepOf(attestation)
        : undefined;
    view.setIdentityStep(step);
    flushSync();
  };
  /** The attestation got or renewed, and what it found shown (IC3). */
  const attest = async () => {
    if (!attestor) return;
    const turn = ++attesting;
    const found = await attestor.refresh();
    if (turn !== attesting || core.closed()) return;
    attestation = found;
    refreshAccount();
  };
  /** « Confirmer votre identité »: a recent sign-in, in the click (IC1);
   * the attestation asked once it ended (`onAccount`). */
  const confirmIdentity = () => {
    if (!signIn || accountState.kind !== "signed-in") return;
    confirming = true;
    signIn.start({ recent: true });
  };
  /** « Nouvelle clé de signature » (NK6): in the click, the
   * account and the refused key read, the recent sign-in its registration
   * needs opened at once; then replaced, and attested (`confirming` asks
   * again once the sign-in ends). */
  const newSigningKey = () => {
    const signed = signedAccount();
    const refused = attestor?.refusedKey();
    if (!signed || !refused) return;
    if (signIn && !signIn.recent()) confirmIdentity();
    void core.busy(async () => {
      const replaced = await keys.replaceRefused(signed, refused);
      core.screen().setNewSigningKeyOffline(replaced === "offline");
      flushSync();
      await attest();
    });
  };
  /** Before an association, in its click (IC2): a sign-in not recent
   * couldn't register the list's key — the recent one opened at once. */
  const confirmFirst = () => {
    if (attestor && signIn && !signIn.recent()) confirmIdentity();
  };

  const start = async () => {
    const env = options.keyring;
    const account = env?.account;
    if (!env || !account) return;
    const {
      gateway: configured,
      attestationKeys,
      orgName: org,
    } = options.config ??
    (await readPageConfig(options.apiBase, (url, init) =>
      env.fetch(url, init),
    ));
    if (!configured || core.closed()) return;
    gateway = configured;
    orgName = org;
    core.screen().setOrg(org);
    flushSync();
    if (attestationKeys) {
      const trusted = new Set(attestationKeys);
      revocations = new RevocationReader({
        apiBase: options.apiBase,
        configured: trusted,
        fetch: (url, init) => env.fetch(url, init),
        setTimer: (run, ms) => env.setTimer(run, ms),
      });
      revocations.subscribe(() => void attest());
      void revocations.read();
      attestor = await Attestor.open({
        gateway: configured,
        configured: trusted,
        local: account.local,
        revocations,
        fetch: (url, init) => env.fetch(url, init),
        now: () => options.now(),
        setTimer: (run, ms) => env.setTimer(run, ms),
        accountSigner: (signed) => keys.accountSigner(signed),
        registrable: (signed, key) => keys.registrable(signed, key),
      });
      if (core.closed()) {
        attestor.close();
        revocations.close();
        return;
      }
    }
    const opened = await SignIn.open({
      gateway: configured,
      local: account.local,
      fetch: (url, init) => env.fetch(url, init),
      setTimer: (run, ms) => env.setTimer(run, ms),
      now: () => options.now(),
      openWindow: (url) => account.openWindow(url),
      channel: (name) => account.channel(name),
      ...(account.client && { client: account.client }),
      onChange: (state) => onAccount(state),
      // A recent sign-in while no attestation of the key is held: its
      // key may have to be registered.
      recent: () => attestor?.wantsRecent() ?? false,
    });
    if (core.closed()) {
      opened.close();
      return;
    }
    signIn = opened;
    onAccount(opened.state());
  };

  /** The account signed in changed (CN4). */
  function onAccount(state: AccountState): void {
    const view = core.screen();
    // Confirming (IC2): shown in progress, the identity kept meanwhile.
    if (confirming && state.kind === "pending") {
      view.setAccount(state);
      flushSync();
      return;
    }
    const confirmed = confirming;
    confirming = false;
    const starting = startingOver;
    startingOver = false;
    const before = signedAccount();
    accountState = state;
    view.setAccount(state);
    const now = signedAccount();
    if (before?.sub !== now?.sub || before?.issuer !== now?.issuer) {
      needsKey = false;
      asked = undefined;
      view.setAccountKeyError("");
      // Signed in, or as another: its key attested, if its list is here;
      // what the list here is to it, decided.
      attestation = undefined;
      if (now) {
        void attest();
        void decide();
      }
    } else if (confirmed && now) {
      // The same identity, signed in again: the key registered now.
      void attest();
    }
    const session = core.session();
    const ref = session?.ref;
    // Signed in again (TR6): what waited is synced.
    if (now && ref && isAccountKeyring(ref) && ofSigned(ref)) {
      void session?.sync();
    } else if (ref && isAccountKeyring(ref)) {
      core.onStatus("signed-out");
    }
    if (now) hooks.signedIn();
    refreshAccount();
    // RL1: started over only once the recent sign-in it asked returned,
    // for the same identity — cancelled or failed, nothing.
    const same = before?.sub === now?.sub && before?.issuer === now?.issuer;
    if (starting && confirmed && now && same && signIn?.recent()) {
      void startOver();
    }
  }

  /** `ref`'s list becomes this device's: the copy here, written under
   * the account (KR-44) — a link's keyring then deleted as KR-29 says, a
   * key that didn't open the account's list replaced (KR-30). */
  const toAccount = async (ref: AccountKeyring, automatic = false) => {
    const env = options.keyring;
    if (!env) return undefined;
    const next = await associate(
      env,
      options.apiBase,
      core.session(),
      ref,
      core.onStatus,
      { automatic },
    );
    if (!next) {
      await core.takenMeanwhile();
      return undefined;
    }
    needsKey = false;
    core.use(next);
    return next.sync();
  };

  /** The latest decision only: a sign-in again, or as another, makes an
   * earlier one moot. */
  let deciding = 0;
  /** What this device's list is to the identity signed in, acted on
   *: nothing to decide, associated at once and said;
   * documents here, asked; the identity's list elsewhere, its key asked.
   * With `confirmed` (« Associer »), associated if the identity still
   * has no list. */
  const decide = async (confirmed = false, again = false): Promise<void> => {
    const env = options.keyring;
    const signed = signedAccount();
    if (!env?.account || !signed) return;
    const turn = ++deciding;
    await core.loaded;
    let found: Situation;
    try {
      found = await situation(env, options.apiBase, core.session(), signed);
    } catch {
      return;
    }
    if (turn !== deciding || core.closed()) return;
    asked = undefined;
    if (found.kind === "automatic" || (confirmed && found.kind === "ask")) {
      const automatic = found.kind === "automatic";
      const status = await associateNow(automatic);
      // A status said meanwhile (TR6: the token ended) stays: the next
      // sync would not say it again.
      if (automatic && status !== undefined && !core.showingStatus()) {
        core.say(t().associatedFuture(identityText()));
        flushSync();
      }
      // A document reached the list here meanwhile, or another tab
      // associated it (RA1): judged again, once, on the list stored.
      if (automatic && status === undefined && !again && !core.closed()) {
        if (turn === deciding) await decide(false, true);
      }
      return;
    }
    if (found.kind === "ask") {
      const later = await env.account.local.associationLater(signed);
      if (turn !== deciding || core.closed()) return;
      asked = { ...found, later };
    }
    if (found.kind === "other") {
      const name = await env.account.local.identityName(found.identity);
      if (turn !== deciding || core.closed()) return;
      asked = {
        kind: "other",
        count: found.count,
        titles: found.titles,
        ...(name && { name }),
      };
    }
    if (found.kind === "associated") void keepName();
    if (found.kind === "open-here") needsKey = true;
    refreshAccount();
  };

  /** The name of the identity signed in, kept on this device: said if
   * another signs in here later. */
  const keepName = async () => {
    const signed = signedAccount();
    if (!signed || accountState.kind !== "signed-in") return;
    await options.keyring?.account?.local
      .keepIdentityName(signed, accountState.name)
      .catch(() => {});
  };

  /** Another identity's list here, associated with the one signed in:
   * under a key of its own if the identity has no list yet, else with
   * the key of the identity's list, asked for (KR-42, merged by KR-30).
   * The other identity's list stays at the gateway. */
  const associateOther = async () => {
    const env = options.keyring;
    const signed = signedAccount();
    if (!env?.account || !signed) return;
    let found: Situation;
    try {
      // Its own list's version only: the list here is not read with its
      // token (TR7).
      found = await situation(env, options.apiBase, undefined, signed);
    } catch {
      return;
    }
    asked = undefined;
    if (found.kind === "automatic") {
      await core.busy(async () => {
        await toAccount({
          ...signed,
          key: crypto.getRandomValues(new Uint8Array(32)),
        });
      });
      void keepName();
      return;
    }
    if (found.kind === "open-here") needsKey = true;
    refreshAccount();
  };

  /** Another identity's list, not kept on this device: it goes from
   * here, and this browser's list is decided anew for the identity. */
  const forgetOther = async () => {
    const env = options.keyring;
    const current = core.session();
    if (!env || !current) return;
    await core.busy(async () => {
      await env.local.forget(current.ref);
      core.leave(current, () => {
        asked = undefined;
      });
    });
    await decide();
  };

  /** This device's list associated with the identity (KR-44), under its
   * own key, or a new one; the sync's status, or `undefined`. */
  const associateNow = async (automatic = false) => {
    const signed = signedAccount();
    if (!signed) return undefined;
    let status: KeyringStatus | undefined;
    await core.busy(async () => {
      status = await toAccount(
        { ...signed, key: associationKey(core.session()) },
        automatic,
      );
    });
    if (status !== undefined) void keepName();
    return status;
  };

  /** « Recommencer une liste » (RL1): agreed, then a
   * recent sign-in if the one here isn't, in the click; started over only
   * once recent. */
  const askStartOver = () => {
    if (!signIn || !signedAccount()) return;
    if (!options.confirm(t().startOverConfirm)) return;
    if (signIn.recent()) {
      void startOver();
      return;
    }
    startingOver = true;
    confirmIdentity();
  };

  /** This browser's list, or a new one, becomes the identity's in place
   * of the one whose key is lost (RL2, RL3): under the list in waiting's
   * own key (KR-44), else a new one; its key shown to keep (RL5). */
  const startOver = () =>
    core.busy(async () => {
      const env = options.keyring;
      const signed = signedAccount();
      if (!env || !signed) return;
      const current = core.session();
      const next: AccountKeyring = {
        ...signed,
        key:
          current && !isAccountKeyring(current.ref)
            ? current.ref.key
            : crypto.getRandomValues(new Uint8Array(32)),
      };
      // A code shown carries the old list.
      hooks.endPairing();
      const started = await KeyringSession.startOver(
        sessionOptions(env, options.apiBase, core.onStatus),
        next,
        current?.doc,
        current?.ref,
      );
      if (!started) {
        await core.takenMeanwhile();
        return;
      }
      needsKey = false;
      asked = undefined;
      core.use(started);
      void keepName();
      core.screen().reveal(keyText(next));
      core.say(t().startedOver);
      flushSync();
    });

  /** « Associer » (KR-44): in the click, the recent sign-in first if
   * needed (IC2). */
  const attach = () => {
    confirmFirst();
    return decide(true);
  };

  /** « Plus tard »: kept on this device, the offer stays, quietly. */
  const later = async () => {
    const env = options.keyring;
    const signed = signedAccount();
    if (!env?.account || !signed || asked?.kind !== "ask") return;
    await env.account.local.keepAssociationLater(signed);
    if (asked?.kind === "ask") asked = { ...asked, later: true };
    refreshAccount();
  };

  /** The account's key, pasted (KR-42): its list opens here, this
   * device's copy merged in. */
  const useAccountKey = (text: string) =>
    core.busy(async () => {
      const signed = signedAccount();
      if (!signed) return;
      let key: Uint8Array;
      try {
        key = parseAccountKey(text);
      } catch {
        core.screen().setAccountKeyError(t().keyInvalid);
        flushSync();
        return;
      }
      core.screen().setAccountKeyError("");
      const status = await toAccount({ ...signed, key });
      if (status === "unreadable") {
        needsKey = true;
        core.screen().setAccountKeyError(t().accountKeyWrong);
        refreshAccount();
      }
    });

  return {
    start,
    signed: signedAccount,
    state: () => accountState,
    refresh: refreshAccount,
    attest,
    forgetAttestation: () => {
      attestation = undefined;
      attesting += 1;
    },
    silences: (status) => {
      const ref = core.session()?.ref;
      if (!ref || !isAccountKeyring(ref)) return false;
      let silenced = false;
      if (status === "unreadable") {
        // Another device attached first, under its key: the account's key is
        // asked for, nothing was written.
        needsKey = true;
        refreshAccount();
        silenced = true;
      }
      // TR7: the list of another identity than the one signed in — said
      // with its choices, not as a status.
      if (status === "signed-out" && signedAccount() && !ofSigned(ref)) {
        silenced = true;
      }
      return silenced;
    },
    joined: () => {
      needsKey = false;
    },
    props: {
      // In the click itself: the window opens without waiting (ADR-0041).
      onSignIn: () => signIn?.start(),
      onCancelSignIn: () => signIn?.cancel(),
      onSignOut: () => void signIn?.signOut(),
      onAttach: () => void attach(),
      onLater: () => void later(),
      onAssociateOther: () => {
        // In the click (IC2).
        confirmFirst();
        void associateOther();
      },
      onConfirmIdentity: () => confirmIdentity(),
      onRetryIdentity: () => void attest(),
      onNewSigningKey: () => newSigningKey(),
      onForgetOther: () => void forgetOther(),
      onAccountKey: (text: string) => void useAccountKey(text),
      // In the click (RL1): the recent sign-in's window opens at once.
      onStartOver: () => askStartOver(),
    },
    close: () => {
      signIn?.close();
      attestor?.close();
      revocations?.close();
    },
  };
}
