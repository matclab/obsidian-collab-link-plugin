import type { DocumentLock } from "../../../web/src/embed.js";

/** `navigator.locks` for tests (jsdom has none): one holder per name,
 * until it lets go. */
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
