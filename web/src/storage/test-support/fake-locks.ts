import type { DocumentLock } from "../local-store.js";

/** `navigator.locks` for tests (jsdom has none): one holder per name,
 * until `release` — what a page's death does. */
export class FakeLocks implements DocumentLock {
  private readonly held = new Set<string>();

  async acquire(name: string): Promise<boolean> {
    if (this.held.has(name)) return false;
    this.held.add(name);
    return true;
  }

  release(name: string): void {
    this.held.delete(name);
  }
}
