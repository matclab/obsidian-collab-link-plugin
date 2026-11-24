import type { CreatedKeyring } from "../../lib/src/index.js";
import type { AccountState } from "../account/sign-in.js";
/** The identity and « Mes documents » in a document: a
 * sign-in made here — decision 20's question —, or one already made, is
 * followed as on the home page. With nothing to decide, the device's list
 * is associated with the identity, the tab's session replaced, and the
 * attestation asked for; otherwise the situation is kept, for the
 * document's identity line to say what to do, on the home page. What is
 * about to be signed waits for this (`settled`): the attestation that
 * follows the sign-in would otherwise be asked for before the list is the
 * identity's, and the object signed without the name. */
import {
  type Identity,
  type Situation,
  associate,
  associationKey,
  situation,
} from "./association.js";
import type { KeyringEnvironment } from "./environment.js";
import { sessionOptions } from "./environment.js";
import { KeyringSession } from "./session.js";

export type DocumentSituation = Situation | { kind: "signed-out" };

export interface DocumentAssociationOptions {
  env: KeyringEnvironment;
  apiBase: string;
  /** The gateway's origin (`/config.json`). */
  gateway: string;
  /** The page's sign-in. */
  gate: {
    state(): AccountState;
    subscribe(listener: () => void): () => void;
  };
  /** The tab's session, as it is now. */
  session(): Promise<KeyringSession | undefined>;
  /** The tab's session from now on. */
  replace(next: KeyringSession): void;
  /** The attestation got or renewed (`Trust.refresh`). */
  refresh(): Promise<void>;
  /** A keyring at the server (LA1); absent, no list in
   * waiting is made. */
  createKeyring?(): Promise<CreatedKeyring>;
}

export class DocumentAssociation {
  private current: DocumentSituation = { kind: "signed-out" };
  private identity: Identity | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly options: DocumentAssociationOptions) {
    this.unsubscribe = options.gate.subscribe(() => this.follow());
    this.follow();
  }

  /** What the list here is to the identity signed in. */
  situation(): DocumentSituation {
    return this.current;
  }

  /** Resolves once what follows the last sign-in is done — that sign-in
   * followed first, whichever of its listeners ran before. */
  settled(): Promise<void> {
    this.follow();
    return this.pending;
  }

  /** Decides again for the identity signed in — its list not known, the
   * gateway out of reach — and resolves once done. */
  retry(): Promise<void> {
    const identity = this.identity;
    if (identity && this.current.kind === "unknown") {
      this.pending = this.pending.then(() => this.decide(identity));
    }
    return this.settled();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
  }

  private follow(): void {
    const state = this.options.gate.state();
    const identity: Identity | undefined =
      state.kind === "signed-in"
        ? {
            gateway: this.options.gateway,
            issuer: state.issuer,
            sub: state.sub,
          }
        : undefined;
    const same =
      identity?.issuer === this.identity?.issuer &&
      identity?.sub === this.identity?.sub;
    if (same) return;
    this.identity = identity;
    if (!identity) {
      this.set({ kind: "signed-out" });
      return;
    }
    // After whatever ran before: one decision at a time in this tab.
    this.pending = this.pending.then(() => this.decide(identity));
  }

  private async decide(identity: Identity): Promise<void> {
    const { env, apiBase } = this.options;
    if (this.closed || this.identity !== identity) return;
    // No list in this tab, one on the device (another tab's, put there
    // since): judged on it.
    if (!(await this.options.session())) await this.takeStored();
    let found = await this.judge(identity);
    if (this.closed || this.identity !== identity) return;
    if (found.kind === "automatic") {
      const current = await this.options.session();
      let next = await associate(
        env,
        apiBase,
        current,
        { ...identity, key: associationKey(current) },
        undefined,
        { automatic: true },
      );
      // Another tab of this device put a list here meanwhile, or a
      // document in it (RA1): the list here is this tab's from now on,
      // and is judged again.
      if (!next) next = await KeyringSession.open(sessionOptions(env, apiBase));
      if (next) this.options.replace(next);
      found = await this.judge(identity);
    }
    if (this.closed || this.identity !== identity) return;
    // The identity's list elsewhere, none here (LA1); another tab's put
    // here meanwhile: judged on it.
    if (found.kind === "open-here" && (await this.wait()) === "taken") {
      found = await this.judge(identity);
    }
    if (this.closed || this.identity !== identity) return;
    this.set(found);
    if (found.kind === "associated") {
      // Its name kept on this device: said if another identity signs in
      // here later.
      const state = this.options.gate.state();
      if (state.kind === "signed-in") {
        await env.account?.local
          .keepIdentityName(identity, state.name)
          .catch(() => {});
      }
      await this.options.refresh();
    }
  }

  /** The identity's list elsewhere, none on this device (LA1): a keyring at the
   * server keeps what is opened here, its key
   * unshown, until the identity's list is opened here and merges it
   * (KR-44, KR-29). Another tab's list put here meanwhile is taken
   * instead, the keyring just made, empty, deleted. */
  private async wait(): Promise<"waiting" | "taken" | undefined> {
    const { env, apiBase, createKeyring } = this.options;
    if (!createKeyring || (await this.options.session())) return undefined;
    let created: CreatedKeyring;
    try {
      created = await createKeyring();
    } catch {
      return undefined;
    }
    if (this.closed) return undefined;
    const options = sessionOptions(env, apiBase);
    const adopted = await KeyringSession.adopt(options, created);
    if (adopted) {
      this.options.replace(adopted);
      return "waiting";
    }
    void options.remove(created).catch(() => {});
    await this.takeStored();
    return "taken";
  }

  /** The device's list, if any, as this tab's. */
  private async takeStored(): Promise<void> {
    const { env, apiBase } = this.options;
    const stored = await KeyringSession.open(sessionOptions(env, apiBase));
    if (stored) this.options.replace(stored);
  }

  /** What the tab's list is to `identity`: the list that replaced it on
   * this device, if another tab associated it or changed its key (RA3) —
   * followed before, and again after: replaced meanwhile, and synced, the
   * identity's list would seem to be elsewhere. */
  private async judge(identity: Identity): Promise<Situation> {
    const { env, apiBase } = this.options;
    const session = await this.options.session();
    try {
      await session?.follow();
      let found: Situation;
      do {
        found = await situation(env, apiBase, session, identity);
      } while (session && (await session.follow()));
      return found;
    } catch {
      return { kind: "unknown" };
    }
  }

  private set(next: DocumentSituation): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}
