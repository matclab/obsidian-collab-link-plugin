/** « Vous connecter pour signer de votre nom ? » (AT3): before the first object
 * a page would sign —
 * an annotation, a reply, a decision, a version; not a keystroke, nor a
 * name in `peers`, nor the presence — a page signed out of a gateway that
 * answers asks once whether to sign in. What is being written waits for
 * the answer, or for the sign-in's end, and is then let through once:
 * never lost, never twice, never while the question waits; nothing once
 * the page is closed. « Continuer sans » is remembered on this device.
 * Signed in, the name not carried yet, the question says why and what
 * to do (IC4): « Confirmer », « Réessayer », the home
 * page; its « Continuer sans » is this page's only. One question a page,
 * whatever it asks. */
import type { AccountState } from "./sign-in.js";

/** Signed in, why what is written doesn't carry the name yet (IC4): the
 * identity to confirm, not confirmed (the gateway out of
 * reach), or the list to see to at the home page. */
export type NotYet = "confirm" | "unconfirmed" | "home";

/** What the dialog shows: the question signed out (`asking`), or signed
 * in with its reason; the sign-in in progress. */
export type PromptView = "hidden" | "asking" | "pending" | NotYet;

/** How long a signed-in page waits for its attestation before what is
 * being written goes on without it. */
export const ATTESTATION_WAIT_MS = 5000;

export interface SignToNameOptions {
  /** The page's sign-in (`SignIn`), as much as the question uses. */
  account: {
    state(): AccountState;
    /** In the click: opens the window (ADR-0041). */
    start(options?: { recent?: boolean }): void;
    cancel(): void;
    subscribe(listener: () => void): () => void;
  };
  /** « Continuer sans » answered on this device. */
  remembered(): boolean;
  remember(): void;
  show(view: PromptView): void;
  /** The attestation of the key, got or renewed (`Attestor.refresh`). */
  attested(): Promise<void>;
  /** Signed in, once attested or not: why the name isn't carried yet,
   * if it isn't (the identity line's reason). */
  notYet?(): NotYet | undefined;
  /** « Réessayer »: the list decided again, then the attestation. */
  retry?(): Promise<void>;
  setTimer(run: () => void, ms: number): () => void;
  /** Told, synchronously, of each object let through (tests). */
  onLetThrough?(): void;
}

export class SignToName {
  private view: PromptView = "hidden";
  private askedThisPage = false;
  private waiting: { resolve: () => void }[] = [];
  private closed = false;
  private unsubscribe = () => {};

  constructor(private readonly options: SignToNameOptions) {}

  /** Resolves when what is about to be signed may be: at once, or once
   * the question is answered and its sign-in ended. */
  before(): Promise<void> {
    if (this.closed) return new Promise(() => {});
    if (this.view !== "hidden") return this.hold();
    const state = this.options.account.state();
    if (state.kind === "signed-in") {
      return new Promise((resolve) => {
        void this.attestedOrLater().then(() => {
          if (this.closed) return;
          // A question shown meanwhile: this one waits for it too.
          if (this.view !== "hidden") {
            this.waiting.push({ resolve });
            return;
          }
          const reason = this.askedThisPage
            ? undefined
            : this.options.notYet?.();
          if (reason) {
            this.askedThisPage = true;
            this.waiting.push({ resolve });
            this.setView(reason);
            return;
          }
          this.options.onLetThrough?.();
          resolve();
        });
      });
    }
    const ask =
      state.kind === "signed-out" &&
      !this.askedThisPage &&
      !this.options.remembered();
    if (!ask) {
      this.options.onLetThrough?.();
      return Promise.resolve();
    }
    this.askedThisPage = true;
    this.setView("asking");
    return this.hold();
  }

  /** How many objects wait (tests). */
  held(): number {
    return this.waiting.length;
  }

  /** « S'identifier », in the click: the window opens at once. */
  signIn(): void {
    if (this.view !== "asking") return;
    this.setView("pending");
    this.unsubscribe = this.options.account.subscribe(() => this.changed());
    this.options.account.start();
  }

  /** « Confirmer »: a recent sign-in, in the click (IC1); what waits
   * goes once it ended, as after « S'identifier ». */
  confirm(): void {
    if (this.view !== "confirm") return;
    this.setView("pending");
    this.unsubscribe = this.options.account.subscribe(() => this.changed());
    this.options.account.start({ recent: true });
  }

  /** « Réessayer »: what waits goes once the list and the attestation
   * are asked again — attested or not. */
  retry(): void {
    if (this.view !== "unconfirmed") return;
    const waiting = this.waiting;
    this.waiting = [];
    this.setView("hidden");
    void (this.options.retry?.() ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.attestedOrLater())
      .then(() => {
        if (this.closed) return;
        this.letThrough(waiting);
      });
  }

  /** « Continuer sans »: remembered on this device signed out; this
   * page only, signed in (IC4). */
  without(): void {
    if (this.view === "hidden" || this.view === "pending") return;
    if (this.view === "asking") this.options.remember();
    this.release();
  }

  /** The dialog closed (Escape, ×): this time only. */
  dismiss(): void {
    if (this.view === "hidden") return;
    if (this.view === "pending") this.options.account.cancel();
    this.release();
  }

  /** « Annuler » while signing in: an answer arriving later changes
   * nothing here (ADR-0041). */
  cancel(): void {
    if (this.view !== "pending") return;
    this.options.account.cancel();
    this.release();
  }

  /** The page closes: what waits is never written. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.waiting = [];
    if (this.view !== "hidden") this.setView("hidden");
  }

  private hold(): Promise<void> {
    return new Promise((resolve) => this.waiting.push({ resolve }));
  }

  private setView(view: PromptView): void {
    this.view = view;
    this.options.show(view);
  }

  /** The account changed while signing in: its end lets through. */
  private changed(): void {
    if (this.view !== "pending") return;
    const state = this.options.account.state();
    if (state.kind === "pending") return;
    this.unsubscribe();
    this.unsubscribe = () => {};
    if (state.kind !== "signed-in") {
      this.release();
      return;
    }
    // Signed in: the attestation first, if it comes soon enough.
    const waiting = this.waiting;
    this.waiting = [];
    this.setView("hidden");
    void this.attestedOrLater().then(() => {
      if (this.closed) return;
      this.letThrough(waiting);
    });
  }

  /** `waiting` let through — after any question shown meanwhile. */
  private letThrough(waiting: { resolve: () => void }[]): void {
    if (this.view !== "hidden") {
      this.waiting.push(...waiting);
      return;
    }
    for (const { resolve } of waiting) {
      this.options.onLetThrough?.();
      resolve();
    }
  }

  /** The attestation's refresh, or `ATTESTATION_WAIT_MS`, whichever ends
   * first; never rejects. */
  private attestedOrLater(): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.options.setTimer(resolve, ATTESTATION_WAIT_MS);
      this.options.attested().then(
        () => {
          cancel();
          resolve();
        },
        () => {
          cancel();
          resolve();
        },
      );
    });
  }

  private release(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
    const waiting = this.waiting;
    this.waiting = [];
    this.setView("hidden");
    for (const { resolve } of waiting) {
      this.options.onLetThrough?.();
      resolve();
    }
  }
}
