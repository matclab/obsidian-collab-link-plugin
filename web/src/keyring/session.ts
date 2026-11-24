/** The keyring opened in a tab (docs/phase-18-trousseau-identite.md): its Loro
 * document, what the page writes into it, the
 * copy on this device and the synchronisation with the server. A write
 * resolves once it is in the stored copy (TR1 locally, TR2); the
 * synchronisation follows, grouped, and never loses what the copy holds
 * (KR-25): it fails, or merges and writes. */
import type { LoroDoc } from "loro-crdt";
import {
  type KeyringCredentials,
  type KeyringEntry,
  type KeyringTransport,
  SignedOut,
  type SyncOutcome,
  listKeyring,
  newKeyringDoc,
  syncKeyring,
} from "../../lib/src/index.js";
import type { KeyringLocal } from "./local.js";
import {
  type AccountKeyring,
  type KeyringRef,
  formatKeyringRef,
  linkOf,
  sameKeyring,
} from "./ref.js";

/** How long after a write the synchronisation goes: writes close together
 * go in one `PUT`. */
export const KEYRING_SYNC_DELAY_MS = 2_000;

/** Where the synchronisation stands, for the page to say. */
export type KeyringStatus =
  | SyncOutcome["kind"]
  /** The server couldn't be reached: the copy holds everything. */
  | "offline"
  /** Another tab put another keyring on this device: reload. */
  | "superseded"
  /** The copy on this device couldn't be written: the next
   * synchronisation writes it again. */
  | "unsaved"
  /** An account's keyring without a token of its account (TR6, TR7):
   * the copy holds everything; the next sign-in syncs it. */
  | "signed-out";

export interface KeyringSessionOptions {
  local: KeyringLocal;
  /** For an account's keyring, a transport that rejects with
   * `SignedOut` without a token of that account. */
  transport(ref: KeyringRef): KeyringTransport;
  /** Deletes a keyring on the server (KR-10, KR-29). */
  remove(credentials: KeyringCredentials): Promise<"deleted" | "missing">;
  /** A timer: injected, so that a test decides when it fires. Returns how
   * to cancel it. */
  setTimer(run: () => void, ms: number): () => void;
  onStatus?(status: KeyringStatus): void;
}

export class KeyringSession {
  private readonly listeners = new Set<() => void>();
  private cancelTimer: (() => void) | undefined;
  private syncing: Promise<KeyringStatus> | undefined;
  private again = false;
  private closed = false;
  /** What the server brought isn't in the stored copy yet. */
  private unsaved = false;
  private syncedHere = false;

  private constructor(
    /** A keyring link's, or an account's. Replaced only
     * by the list that replaced it on this device (RA2, `save`). */
    public ref: KeyringRef,
    readonly doc: LoroDoc,
    private readonly options: KeyringSessionOptions,
  ) {}

  /** The keyring stored on this device, if any; a copy that doesn't
   * read starts empty and is filled from the server. */
  static async open(
    options: KeyringSessionOptions,
  ): Promise<KeyringSession | undefined> {
    const stored = await options.local.load();
    if (!stored) return undefined;
    const session = new KeyringSession(
      stored.ref,
      stored.doc ?? newKeyringDoc(),
      options,
    );
    session.schedule(0);
    return session;
  }

  /** Puts this keyring on the device (a new one, or one pasted), with
   * `doc` as its copy, then syncs. `undefined` if another tab put another
   * keyring here meanwhile: nothing written (`claim`). With `replacing`,
   * it takes the place of the keyring stored, known gone (cas 12). */
  static async adopt(
    options: KeyringSessionOptions,
    ref: KeyringRef,
    doc: LoroDoc = newKeyringDoc(),
    replacing = false,
  ): Promise<KeyringSession | undefined> {
    if (replacing) await options.local.replace(ref, doc);
    else if ((await options.local.claim(ref, doc)) === "taken") {
      return undefined;
    }
    const session = new KeyringSession(ref, doc, options);
    session.schedule(0);
    return session;
  }

  /** A keyring handed over by another device (KR-37): it
   * becomes this device's, with whatever the copy here held merged in;
   * then syncs. The list of another keyring here is merged only with
   * `merge` (`local.join`): else `other`, and no session. */
  static async join(
    options: KeyringSessionOptions,
    ref: KeyringRef,
    merge = false,
  ): Promise<
    | { session: KeyringSession; was: "nothing-here" | "same" | "merged" }
    | { session: undefined; was: "other" }
  > {
    const doc = newKeyringDoc();
    const was = await options.local.join(ref, doc, { merge });
    if (was === "other") return { session: undefined, was };
    const session = new KeyringSession(ref, doc, options);
    session.schedule(0);
    return { session, was };
  }

  /** Changes the key (KR-29): `next`, a keyring just created — or an
   * account's, to attach this one to (KR-44) —, takes `current`'s copy,
   * the old one noted to delete in the same write; it is synced, then the
   * old one is deleted. Resolves with the new session once the copy is
   * stored; the rest follows. `current` is a keyring link's: an
   * account's keyring has no key to change. What the
   * copy stored holds is merged in first; `undefined` if another tab put
   * another keyring here meanwhile: nothing written. */
  static async rotate(
    current: KeyringSession,
    next: KeyringRef,
    options?: { onlyIfEmpty?: boolean },
  ): Promise<KeyringSession | undefined> {
    const old = linkOf(current.ref);
    const rotated = await current.options.local.rotate(
      next,
      current.doc,
      old,
      options,
    );
    // Another list here, or (RA1) documents in the copy: nothing written.
    if (rotated !== "rotated") return undefined;
    current.close();
    const session = new KeyringSession(next, current.doc, current.options);
    session.schedule(0);
    return session;
  }

  /** Starts the identity's list over (RL2): `next`, a
   * new key of the identity's keyring, takes the place of `current` (the
   * list stored, or none) with `doc` and the copy stored merged in, noted
   * to write over the server's list that doesn't read (RL3); then syncs.
   * `undefined` if another tab put another list here meanwhile: nothing
   * written. */
  static async startOver(
    options: KeyringSessionOptions,
    next: AccountKeyring,
    doc: LoroDoc = newKeyringDoc(),
    current?: KeyringRef,
  ): Promise<KeyringSession | undefined> {
    if ((await options.local.startOver(next, doc, current)) === "taken") {
      return undefined;
    }
    const session = new KeyringSession(next, doc, options);
    session.schedule(0);
    return session;
  }

  /** Whether an old keyring is still to delete (KR-29): until then, its
   * key still opens the list. */
  async retiring(): Promise<boolean> {
    return (await this.options.local.retired()).some(
      (old) => !sameKeyring(old, this.ref),
    );
  }

  entries(): KeyringEntry[] {
    return listKeyring(this.doc);
  }

  /** Whether a synchronisation of this page reached the server: what
   * the list holds there is in the copy (UK4). */
  get synced(): boolean {
    return this.syncedHere;
  }

  /** Called after each change of the list (a write, a merge). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies `edit` (functions of the keyring's model, which commit),
   * and resolves once the result is in the stored copy. */
  async change(edit: (doc: LoroDoc) => void): Promise<"saved" | "superseded"> {
    const before = this.doc.oplogVersion();
    edit(this.doc);
    if (this.doc.oplogVersion().compare(before) === 0) return "saved";
    this.notify();
    const saved = await this.save();
    if (saved === "superseded") this.options.onStatus?.("superseded");
    else this.schedule(KEYRING_SYNC_DELAY_MS);
    this.notify();
    return saved;
  }

  /** Applies `edit` under the device's lock, once the stored copy is
   * merged in (UK1): what another holder of the list here
   * wrote is seen before deciding — a key drawn once on the device. */
  async changeStored(
    edit: (doc: LoroDoc) => void,
  ): Promise<"saved" | "superseded"> {
    const before = this.doc.oplogVersion();
    const saved = await this.save(edit);
    if (saved === "superseded") this.options.onStatus?.("superseded");
    else if (this.doc.oplogVersion().compare(before) !== 0) {
      this.schedule(KEYRING_SYNC_DELAY_MS);
      this.notify();
    }
    return saved;
  }

  /** Syncs now; one at a time, again if asked meanwhile. Never rejects:
   * a failure is a status. */
  sync(): Promise<KeyringStatus> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.syncing = (async () => {
      let status: KeyringStatus;
      do {
        this.again = false;
        status = await this.syncOnce();
        // The new keyring holds everything: the old one may go (KR-29).
        // A sync asked meanwhile runs after it: until `syncing` is
        // cleared, its caller waits on this one.
        if (status === "synced" && !this.closed && !this.again) {
          // A note that can't be read or cleared stays for the next one.
          await this.deleteRetired().catch(() => {});
        }
      } while (this.again && !this.closed);
      this.syncing = undefined;
      if (status === "synced") this.syncedHere = true;
      this.options.onStatus?.(status);
      return status;
    })();
    return this.syncing;
  }

  /** No more timers, no more writes from this session. */
  close(): void {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private async syncOnce(): Promise<KeyringStatus> {
    if (this.closed) return "offline";
    const before = this.doc.oplogVersion();
    // RL3: the list started over writes over the server's, until synced
    // — asked when a blob that doesn't read is found, not before: another
    // tab of this device may have written it and cleared the note since.
    // The list this sync is of: `ref` may follow another meanwhile (RA2),
    // whose note isn't this sync's to read or clear.
    const ref = this.ref;
    let overwrite = false;
    const startingOver = async () => {
      try {
        overwrite = await this.options.local.startingOver(ref);
      } catch {
        overwrite = false;
      }
      return overwrite;
    };
    let outcome: SyncOutcome;
    try {
      outcome = await syncKeyring(
        this.doc,
        ref.key,
        this.options.transport(ref),
        {
          // The wait after a `412` is a timer of the session's: never one
          // a test doesn't decide.
          wait: (round) =>
            new Promise<void>((resolve) => {
              this.options.setTimer(resolve, 100 * 2 ** (round - 1));
            }),
          overwrite: startingOver,
        },
      );
    } catch (error) {
      // Nothing written without the account's token (TR6).
      return error instanceof SignedOut ? "signed-out" : "offline";
    }
    // Written: the note goes. Left by a page closed before, this sync read its
    // own list: it goes too.
    if (outcome.kind === "synced" && (overwrite || (await startingOver()))) {
      await this.options.local.clearStartOver(ref).catch(() => {});
    }
    // What the server brought is kept here too.
    const brought = this.doc.oplogVersion().compare(before) !== 0;
    if (brought) this.notify();
    if ((brought || this.unsaved) && !this.closed) {
      let saved: "saved" | "superseded";
      try {
        saved = await this.save();
      } catch {
        this.unsaved = true;
        return "unsaved";
      }
      this.unsaved = false;
      if (saved === "superseded") return "superseded";
    }
    return outcome.kind;
  }

  /** Deletes the old keyrings noted by changes of key; a failure leaves
   * its note, for the next synchronisation. Never the current one: a key
   * pasted again (KR-30) makes an old keyring the list again. */
  private async deleteRetired(): Promise<void> {
    const current = formatKeyringRef(this.ref);
    for (const old of await this.options.local.retired()) {
      if (formatKeyringRef(old) === current) {
        // Forgotten only if it is the device's list again (a key pasted
        // again), decided under the lock: a tab left on a list replaced
        // here (RA2, followed at its next write) would otherwise forget
        // it undeleted (found by the scenario of 18p.3).
        await this.options.local.clearRetired(old, { ifStored: true });
        continue;
      }
      try {
        await this.options.remove(old);
      } catch {
        continue;
      }
      await this.options.local.clearRetired(old);
    }
  }

  /** Follows the list that replaced this one on the device — by a change
   * of key or an association in another tab, never another list put here
   * —, its copy merged in; nothing written (RA2, RA3).
   * Whether it followed. */
  async follow(): Promise<boolean> {
    const ref = this.ref;
    const next = await this.options.local.successor(ref);
    if (!next || this.closed) return false;
    // Followed meanwhile (a write's RA2): already there.
    if (this.ref !== ref) return true;
    this.ref = next.ref;
    if (next.doc)
      this.doc.import(
        next.doc.export({ mode: "update", from: this.doc.oplogVersion() }),
      );
    this.notify();
    return true;
  }

  /** The copy stored under this list; if another tab of the device
   * replaced it (a change of key, an association), followed to the list
   * that replaced it, then stored there (RA2). */
  private async save(
    edit?: (doc: LoroDoc) => void,
  ): Promise<"saved" | "superseded"> {
    const ref = this.ref;
    const saved = await this.options.local.save(ref, this.doc, edit);
    if (saved === "saved" || this.closed) return saved;
    // Followed while this write waited (RA3), or now.
    if (this.ref === ref && !(await this.follow())) return saved;
    return this.options.local.save(this.ref, this.doc, edit);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.cancelTimer?.();
    this.cancelTimer = this.options.setTimer(() => {
      this.cancelTimer = undefined;
      void this.sync();
    }, ms);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
