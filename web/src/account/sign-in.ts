/** Signing in from a tab (docs/phase-18-trousseau-identite.md, ADR-0041): an
 * attempt prepared before the click, the window
 * opened in it, the return from `/auth-return` taken for the attempt in
 * progress only and once (CN1), a late answer ignored and its token ended
 * (CN2), the token forgotten before logout (CN3), and what is shown the
 * account kept on this device, read again whenever a tab says it changed
 * (CN4). The token's deadline is this device's clock (ID-25). */
import {
  type SignInAttempt,
  TOKEN_MS,
  endGatewaySession,
  exchangeSignInCode,
  gatewayHealthy,
  newSignInAttempt,
  readSignInMessage,
  signInAddress,
} from "../../lib/src/index.js";
import type { AccountLocal, SignedIn } from "../keyring/local.js";
import { ACCOUNT_CHANNEL, SIGN_IN_CHANNEL } from "./channels.js";

export { ACCOUNT_CHANNEL, SIGN_IN_CHANNEL } from "./channels.js";

/** How long a recent sign-in's token is recent (ID-28). */
export const RECENT_MS = 600_000;

/** How long the gateway has to answer `/accounts/health` (ADR-0041). */
export const HEALTH_MS = 3000;

/** A `BroadcastChannel`, as much as the page uses of it. */
export interface AccountChannel {
  post(data: unknown): void;
  listen(listener: (data: unknown) => void): () => void;
}

export type AccountState =
  /** No gateway that answers, and no account kept. */
  | { kind: "unavailable" }
  /** `ready` once an attempt is prepared: the click opens it at once. */
  | {
      kind: "signed-out";
      ready: boolean;
      reason?: "denied" | "failed" | "expired";
    }
  /** The window is open, or its code being exchanged. */
  | { kind: "pending" }
  | {
      kind: "signed-in";
      name: string;
      email: string | null;
      issuer: string;
      sub: string;
    };

export interface SignInOptions {
  /** The gateway's origin (`/config.json`). */
  gateway: string;
  local: AccountLocal;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimer(run: () => void, ms: number): () => void;
  /** This device's clock, in milliseconds. */
  now(): number;
  openWindow(url: string): void;
  /** Outside a browser, where the return comes (ID-41): the plugin's. */
  client?: "obsidian";
  channel(name: string): AccountChannel;
  /** Tests give attempts of their own. */
  newAttempt?: () => Promise<SignInAttempt>;
  /** Whether the next sign-in should be recent (ID-28): read at the
   * click — when this device holds no valid attestation. */
  recent?: () => boolean;
  onChange?: (state: AccountState) => void;
}

interface Attempt {
  value: SignInAttempt;
  /** Asked with `fresh` (ID-28). */
  recent: boolean;
  /** `window` until its return arrives, then `exchange`. */
  phase: "window" | "exchange";
}

export class SignIn {
  private healthy = false;
  private record: SignedIn | undefined;
  private next: SignInAttempt | undefined;
  private preparing = false;
  private attempt: Attempt | undefined;
  private reason: "denied" | "failed" | "expired" | undefined;
  private signingOut = false;
  private closed = false;
  private cancelDeadline = () => {};
  private readonly account: AccountChannel;
  private readonly unlisten: (() => void)[] = [];

  private constructor(private readonly options: SignInOptions) {
    this.account = options.channel(ACCOUNT_CHANNEL);
    this.unlisten.push(
      options.channel(SIGN_IN_CHANNEL).listen((data) => this.returned(data)),
      this.account.listen(() => void this.reload()),
    );
  }

  /** Resolves once the gateway answered (or `HEALTH_MS` passed) and the
   * account kept here, if any, is read. */
  static async open(options: SignInOptions): Promise<SignIn> {
    const signIn = new SignIn(options);
    signIn.prepare();
    const [healthy] = await Promise.all([
      gatewayHealthy(options.gateway, {
        fetch: (url, init) => options.fetch(url, init),
        setTimer: (run, ms) => options.setTimer(run, ms),
        ms: HEALTH_MS,
      }),
      signIn.reload(),
    ]);
    signIn.healthy = healthy;
    signIn.notify();
    // A page closed during its write couldn't tell of it: the one that
    // opens has every tab read again (CN4).
    signIn.announce();
    return signIn;
  }

  state(): AccountState {
    if (this.attempt) return { kind: "pending" };
    const record = this.record;
    if (record) {
      const { name, email, issuer, sub } = record;
      return { kind: "signed-in", name, email, issuer, sub };
    }
    if (!this.healthy) return { kind: "unavailable" };
    return {
      kind: "signed-out",
      ready: this.next !== undefined,
      ...(this.reason && { reason: this.reason }),
    };
  }

  /** In the click's handler, without waiting (ADR-0041, point 6): opens
   * the window on the prepared attempt, which becomes the one in
   * progress; another click replaces it; recent (ID-28) if asked so. */
  start(options: { recent?: boolean } = {}): void {
    const value = this.next;
    if (this.closed || !value) return;
    this.next = undefined;
    // « Confirmer votre identité » is recent, whatever is wanted
    // (IC1).
    const recent = options.recent ?? this.options.recent?.() ?? false;
    this.attempt = { value, phase: "window", recent };
    this.reason = undefined;
    this.options.openWindow(
      signInAddress(this.options.gateway, value, {
        fresh: recent,
        ...(this.options.client && { client: this.options.client }),
      }),
    );
    this.notify();
    this.prepare();
  }

  /** Whether the token kept here is recent now (ID-28). */
  recent(): boolean {
    return (this.record?.recentUntil ?? 0) > this.options.now();
  }

  /** The attempt in progress, if any, is no longer awaited (CN2). */
  cancel(): void {
    if (!this.attempt) return;
    this.attempt = undefined;
    this.reason = undefined;
    this.notify();
  }

  /** Forgets the token here, then ends it at the gateway (CN3). */
  async signOut(): Promise<void> {
    const record = this.record;
    if (!record || this.signingOut) return;
    this.signingOut = true;
    const forgotten = await this.forget(record.token);
    this.signingOut = false;
    // Not forgotten: still kept, still signed in.
    if (!forgotten) return;
    this.reason = undefined;
    this.notify();
    await this.end(record.token);
  }

  close(): void {
    this.closed = true;
    this.attempt = undefined;
    this.cancelDeadline();
    for (const unlisten of this.unlisten) unlisten();
  }

  private notify(): void {
    if (!this.closed) this.options.onChange?.(this.state());
  }

  private announce(): void {
    this.account.post({ changed: true });
  }

  private prepare(): void {
    if (this.preparing || this.next || this.closed) return;
    this.preparing = true;
    (this.options.newAttempt ?? newSignInAttempt)().then(
      (attempt) => {
        this.preparing = false;
        this.next = attempt;
        this.notify();
      },
      () => {
        this.preparing = false;
      },
    );
  }

  /** A message on the sign-in channel: any page of the origin may write
   * there (CN1). */
  private returned(data: unknown): void {
    const read = readSignInMessage(data);
    const current = this.attempt;
    if (!read || !current || current.phase !== "window") return;
    if (read.request !== current.value.request) return;
    if ("error" in read) {
      this.attempt = undefined;
      this.reason = read.error;
      this.notify();
      return;
    }
    current.phase = "exchange";
    void this.exchange(current, read.code);
  }

  private async exchange(current: Attempt, code: string): Promise<void> {
    const { gateway, local } = this.options;
    const sentAt = this.options.now();
    let session: Awaited<ReturnType<typeof exchangeSignInCode>> | "failed";
    try {
      session = await exchangeSignInCode(gateway, code, current.value, (u, i) =>
        this.options.fetch(u, i),
      );
    } catch {
      session = "failed";
    }
    const stillAwaited = () => this.attempt === current && !this.closed;
    if (typeof session !== "object") {
      if (!stillAwaited()) return;
      this.attempt = undefined;
      this.reason = "failed";
      this.notify();
      return;
    }
    const { token } = session;
    if (!stillAwaited()) {
      await this.end(token);
      return;
    }
    const record: SignedIn = {
      gateway,
      token,
      // ID-25: the token was made after the sending.
      deadline: sentAt + TOKEN_MS,
      // ID-28: recent from its exchange, on the gateway's clock; from the
      // sending, on this one's — never longer.
      ...(current.recent && { recentUntil: sentAt + RECENT_MS }),
      name: session.name,
      email: session.email,
      issuer: session.issuer,
      sub: session.sub,
    };
    try {
      await local.keepSignedIn(record);
    } catch {
      if (stillAwaited()) {
        this.attempt = undefined;
        this.reason = "failed";
        this.notify();
      }
      await this.end(token);
      return;
    }
    if (!stillAwaited()) {
      // Cancelled while it was being kept: not kept (CN2). This tab, or
      // another, may have read it meanwhile: told, like any write; and it
      // may have replaced another account, now gone too: read again
      // (CN4).
      await this.forget(token);
      await this.reload();
      await this.end(token);
      return;
    }
    this.attempt = undefined;
    this.setRecord(record);
    this.announce();
    this.notify();
  }

  /** Ends `token` at the gateway, if it answers: one never kept, or no
   * longer, expires anyway. */
  private async end(token: string): Promise<void> {
    try {
      await endGatewaySession(this.options.gateway, token, (u, i) =>
        this.options.fetch(u, i),
      );
    } catch {}
  }

  /** Forgets `token` here, and says so; `false` if it couldn't. */
  private async forget(token: string): Promise<boolean> {
    try {
      await this.options.local.forgetSignedIn(token);
    } catch {
      return false;
    }
    if (this.record?.token === token) this.setRecord(undefined);
    this.announce();
    return true;
  }

  /** Reads the account kept here (CN4). Reads and writes end in their
   * order (IndexedDB runs the transactions on a store in the order they
   * were made): a read is never older than a write of this tab that ended
   * before it. */
  private async reload(): Promise<void> {
    let read: SignedIn | undefined;
    try {
      read = await this.options.local.signedIn();
    } catch {
      read = undefined;
    }
    if (this.closed) return;
    if (read && read.deadline <= this.options.now()) {
      void this.forget(read.token);
      read = undefined;
    }
    if (read && read.gateway !== this.options.gateway) read = undefined;
    this.setRecord(read);
    this.notify();
  }

  private setRecord(record: SignedIn | undefined): void {
    this.record = record;
    this.cancelDeadline();
    this.cancelDeadline = () => {};
    if (!record) return;
    this.cancelDeadline = this.options.setTimer(
      () => void this.expire(record),
      Math.max(0, record.deadline - this.options.now()),
    );
  }

  /** The deadline came (entrelacement 7). */
  private async expire(record: SignedIn): Promise<void> {
    if (this.record?.token !== record.token) return;
    this.setRecord(undefined);
    this.reason = "expired";
    this.notify();
    await this.forget(record.token);
  }
}
