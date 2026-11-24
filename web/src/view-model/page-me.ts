/** Who « I » am in a page (ADR-0050 §2): my keys' fingerprints, the
 * account signed in, my pseudonym; the same object while none changed. */
import type { MeSource } from "./awaiting-index.js";
import type { Me } from "./awaiting.js";

export class PageMe implements MeSource {
  private me: Me;
  private readonly listeners = new Set<() => void>();

  constructor(pseudonym: string) {
    this.me = { keys: new Set(), pseudonym };
  }

  current(): Me {
    return this.me;
  }

  setPseudonym(pseudonym: string): void {
    if (pseudonym !== this.me.pseudonym) this.change({ pseudonym });
  }

  setAccount(account: { issuer: string; sub: string } | undefined): void {
    const now = this.me.account;
    if (now?.issuer === account?.issuer && now?.sub === account?.sub) return;
    const { account: _, ...rest } = this.me;
    this.me = { ...rest, ...(account && { account }) };
    this.tell();
  }

  /** In hexadecimal (ID-5). */
  setKeys(fingerprints: Iterable<string>): void {
    const keys = new Set(fingerprints);
    const now = this.me.keys;
    if (keys.size === now.size && [...keys].every((key) => now.has(key))) {
      return;
    }
    this.change({ keys });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private change(part: Partial<Me>): void {
    this.me = { ...this.me, ...part };
    this.tell();
  }

  private tell(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
