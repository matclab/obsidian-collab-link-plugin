/** The attestation of this device's key (docs/phase-18-trousseau- identite.md,
 * docs/protocol/06-identity.md, ID-28 – ID-30, ID-38). Only the key of the
 * account's keyring is attested (SG2): one
 * device's own key, registered, would revoke the others' in turn. With a
 * recent token, a key the account doesn't hold is registered, then
 * attested; without one, a recent sign-in is asked for. An attestation
 * kept is renewed when less than 7 days are left, by an ordinary token,
 * and given only for its key, only while valid (AT2). A token refused, or
 * a gateway out of reach, keeps what was obtained (case 3, decision 13).
 * A key that can't be attested for the account any more is refused
 * without asking the gateway (NK1, NK2): revoked by the page's
 * revocation list, or refused at registration — kept on the device. */
import {
  type Attestation,
  type Signer,
  readAttestationEntry,
  registerKey,
  requestAttestation,
  revocationOf,
} from "../../lib/src/index.js";
import type {
  AccountLocal,
  KeptAttestation,
  RefusedKey,
} from "../keyring/local.js";
import type { RevocationSource } from "./revocations.js";

/** Renewed when less than this is left. */
export const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;
/** A renewal that failed is tried again after this. */
export const RETRY_MS = 10 * 60 * 1000;

export type AttestorState =
  /** An attestation of the key, valid now, is held. */
  | "attested"
  /** None, and none to get now: signed out, no account keyring here, the
   * gateway out of reach. */
  | "unattested"
  /** The account doesn't hold this key, and the token isn't recent. */
  | "needs-recent"
  /** The gateway won't register this key: revoked, or another's (NK1). */
  | "refused";

export interface AttestorOptions {
  /** The gateway's origin (`/config.json`). */
  gateway: string;
  /** The attestation keys trusted (`/config.json`, ID-26). */
  configured: ReadonlySet<string>;
  local: AccountLocal;
  /** The page's revocation list (ID-40): a key it revokes is refused
   * before anything is asked (NK2). */
  revocations?: Pick<RevocationSource, "current">;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** This device's clock, in milliseconds. */
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
  /** The key of the account's keyring (KR-38), if this tab's keyring is
   * the keyring of `account`; none otherwise (SG2). */
  accountSigner(account: {
    gateway: string;
    issuer: string;
    sub: string;
  }): Promise<Signer | undefined>;
  /** Whether `publicKey` is still the key of the account's list once
   * synced now (NK5): asked before registering it. */
  registrable?(
    account: { gateway: string; issuer: string; sub: string },
    publicKey: Uint8Array,
  ): Promise<boolean>;
}

interface Held {
  kept: KeptAttestation;
  attestation: Attestation;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class Attestor {
  private held: Held | undefined;
  private running: Promise<AttestorState> | undefined;
  /** The run after the one going on, if asked meanwhile. */
  private queued: Promise<AttestorState> | undefined;
  private cancelTimer = () => {};
  private closed = false;
  /** What the last refresh found. */
  private last: AttestorState | undefined;
  /** The key the last refresh found refused, if it did. */
  private refused: Uint8Array | undefined;
  /** A refusal at registration kept on the device (NK1). */
  private kept: RefusedKey | undefined;

  private constructor(private readonly options: AttestorOptions) {}

  static async open(options: AttestorOptions): Promise<Attestor> {
    const attestor = new Attestor(options);
    try {
      const kept = await options.local.attestation();
      if (kept) await attestor.hold(kept);
    } catch {
      // Nothing kept to read: none held.
    }
    attestor.kept = await options.local.refusedKey().catch(() => undefined);
    return attestor;
  }

  /** The envelope of an attestation of `publicKey` valid now, if held
   * (AT2): what a seal writes with the object it signs (ID-38). */
  envelopeFor(publicKey: Uint8Array): Uint8Array | undefined {
    const held = this.held;
    if (!held || toHex(held.attestation.key) !== toHex(publicKey)) {
      return undefined;
    }
    return this.validNow(held.attestation) ? held.kept.envelope : undefined;
  }

  /** The account keyring's key the last refresh found refused (NK1):
   * the one a new key replaces. */
  refusedKey(): Uint8Array | undefined {
    return this.last === "refused" ? this.refused : undefined;
  }

  /** Whether a sign-in should be recent: no attestation
   * valid now is held, so the key may have to be registered. */
  wantsRecent(): boolean {
    // Or the last refresh said so: what is held may be another key's
    // (IC1).
    if (this.last === "needs-recent") return true;
    // A refused key registers no more: a new one asks for it (NK6).
    if (this.last === "refused") return false;
    return !this.held || !this.validNow(this.held.attestation);
  }

  /** Gets, or renews, the attestation of the account keyring's key; one
   * at a time in this tab. */
  refresh(): Promise<AttestorState> {
    // Asked while a run goes on: what it read may be stale (the list became the
    // identity's meanwhile) — one more run
    // after it, shared by every call made meanwhile.
    if (this.running) {
      this.queued ??= this.running.then(() => {
        this.queued = undefined;
        return this.refresh();
      });
      return this.queued;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Resolves once no refresh runs (tests). */
  async refreshing(): Promise<void> {
    while (this.running || this.queued) await (this.queued ?? this.running);
  }

  close(): void {
    this.closed = true;
    this.cancelTimer();
  }

  private validNow(attestation: Attestation): boolean {
    const now = this.options.now();
    return (
      attestation.issuedAt * 1000 <= now && now < attestation.expiresAt * 1000
    );
  }

  /** Holds `kept` if it reads as an attestation of a configured key. */
  private async hold(kept: KeptAttestation): Promise<boolean> {
    const id = toHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", kept.envelope as BufferSource),
      ),
    );
    const attestation = await readAttestationEntry(
      id,
      kept.envelope,
      this.options.configured,
    );
    if (!attestation) return false;
    this.held = { kept, attestation };
    return true;
  }

  private async run(): Promise<AttestorState> {
    const { gateway, configured, local, now } = this.options;
    const fetchFn = (url: string, init?: RequestInit) =>
      this.options.fetch(url, init);
    let account: Awaited<ReturnType<AccountLocal["signedIn"]>>;
    try {
      account = await local.signedIn();
    } catch {
      account = undefined;
    }
    if (!account || account.gateway !== gateway || account.deadline <= now()) {
      return this.settled("unattested");
    }
    // The key of the moment: an answer for it is held for it only (AT2,
    // case 2).
    const signer = await this.options.accountSigner(account);
    if (!signer) return this.settled("unattested");
    // Refused for good: nothing to ask (NK1, NK2).
    const keptRefused = this.kept;
    if (
      revocationOf(this.options.revocations?.current(), signer.publicKey) !==
        undefined ||
      (keptRefused &&
        keptRefused.gateway === gateway &&
        keptRefused.issuer === account.issuer &&
        keptRefused.sub === account.sub &&
        toHex(keptRefused.key) === toHex(signer.publicKey))
    ) {
      return this.settled("refused", signer.publicKey);
    }
    const held = this.held;
    if (
      held &&
      toHex(held.attestation.key) === toHex(signer.publicKey) &&
      held.attestation.expiresAt * 1000 - now() > RENEW_BEFORE_MS &&
      this.validNow(held.attestation)
    ) {
      return this.settled("attested");
    }
    try {
      let got = await requestAttestation(
        gateway,
        account.token,
        signer.publicKey,
        configured,
        fetchFn,
      );
      if (got === "not-the-key") {
        // The account holds none, or another: registered only from a
        // recent token (GW7), then asked again.
        if ((account.recentUntil ?? 0) <= now()) {
          return this.settled("needs-recent");
        }
        // Only what the server holds (NK5): a key written here and not
        // pushed waits for a synchronisation.
        const named = { gateway, issuer: account.issuer, sub: account.sub };
        if (
          this.options.registrable &&
          !(await this.options.registrable(named, signer.publicKey))
        ) {
          return this.settled(this.heldFor(signer) ? "attested" : "unattested");
        }
        const registered = await registerKey(
          gateway,
          account.token,
          account,
          signer,
          fetchFn,
        );
        if (registered === "not-recent") return this.settled("needs-recent");
        if (registered === "refused") {
          const refused: RefusedKey = {
            gateway,
            issuer: account.issuer,
            sub: account.sub,
            key: signer.publicKey,
          };
          this.kept = refused;
          try {
            await local.keepRefusedKey(refused);
          } catch {
            // Known to this page only; found again by the next.
          }
          return this.settled("refused", signer.publicKey);
        }
        if (registered === "signed-out") return this.settled("unattested");
        got = await requestAttestation(
          gateway,
          account.token,
          signer.publicKey,
          configured,
          fetchFn,
        );
      }
      if (typeof got !== "object") {
        // Signed out, or the key replaced meanwhile on another device
        // (case 7): what was held stays until its end.
        return this.settled(this.heldFor(signer) ? "attested" : "unattested");
      }
      const kept: KeptAttestation = {
        gateway,
        issuer: account.issuer,
        sub: account.sub,
        envelope: got.envelope,
      };
      this.held = { kept, attestation: got.attestation };
      try {
        await local.keepAttestation(kept);
      } catch {
        // Held for this page's life; asked again at the next opening.
      }
      return this.settled("attested");
    } catch {
      // The gateway out of reach, or an answer not of its form.
      return this.settled(this.heldFor(signer) ? "attested" : "unattested");
    }
  }

  private heldFor(signer: Signer): boolean {
    return this.envelopeFor(signer.publicKey) !== undefined;
  }

  /** Schedules the renewal of what is held: at 7 days from its end, or,
   * past that, 10 minutes later — never at once, in a loop. */
  private settled(state: AttestorState, refused?: Uint8Array): AttestorState {
    this.last = state;
    this.refused = refused;
    this.cancelTimer();
    this.cancelTimer = () => {};
    const held = this.held;
    if (!this.closed && held && state === "attested") {
      const at = held.attestation.expiresAt * 1000 - RENEW_BEFORE_MS;
      this.cancelTimer = this.options.setTimer(
        () => void this.refresh(),
        Math.max(RETRY_MS, at - this.options.now()),
      );
    }
    return state;
  }
}
