import type { Activity } from "../connection.js";

/** What a client has in progress, counted, and the wait for none of it
 * (AGENTS.md §1.6), in place of a delay: each turn lets every microtask
 * through (the fake servers answer in them) and one macrotask (a WebCrypto
 * call that ended, a timer, both counted), then reads the count.
 *
 * Counted as `ConnectOptions.activity` by a connection; for what has no
 * such counter (the home page), at the boundary of the environment a test
 * gives it: each request, each operation on the device's stores, each
 * timer and each WebCrypto call — between them, the code under test runs
 * in microtasks only. */
export class ActivityCount implements Activity {
  inProgress = 0;

  begin(): void {
    this.inProgress++;
  }

  end(): void {
    this.inProgress--;
  }

  /** Resolves once nothing counted is in progress. */
  async settled(): Promise<void> {
    do {
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (this.inProgress > 0);
  }

  /** `run`, each call's promise counted until it settles. */
  counted<A extends unknown[], R>(
    run: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return (...args) => {
      this.begin();
      let result: Promise<R>;
      try {
        result = run(...args);
      } catch (error) {
        this.end();
        throw error;
      }
      return result.finally(() => this.end());
    };
  }

  /** `target`, each of its methods that returns a promise counted. */
  methods<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (object, name, receiver) => {
        const value = Reflect.get(object, name, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = value.apply(object, args);
          if (!(result instanceof Promise)) return result;
          this.begin();
          return result.finally(() => this.end());
        };
      },
    });
  }

  /** A `setTimer` whose timers are counted until they fire or are
   * cancelled. */
  timers(
    setTimer: (run: () => void, ms: number) => () => void,
  ): (run: () => void, ms: number) => () => void {
    return (run, ms) => {
      let pending = true;
      const done = () => {
        if (!pending) return;
        pending = false;
        this.end();
      };
      this.begin();
      const cancel = setTimer(() => {
        done();
        run();
      }, ms);
      return () => {
        done();
        cancel();
      };
    };
  }

  /** WebCrypto's calls (`crypto.subtle`), counted until `restore`. */
  countCrypto(): () => void {
    const subtle = globalThis.crypto.subtle;
    /** Each method replaced, and whether it was the object's own. */
    const kept = new Map<string, { original: unknown; own: boolean }>();
    for (const name of [
      "encrypt",
      "decrypt",
      "sign",
      "verify",
      "digest",
      "generateKey",
      "deriveKey",
      "deriveBits",
      "importKey",
      "exportKey",
      "wrapKey",
      "unwrapKey",
    ] as const) {
      const original = subtle[name] as (...args: unknown[]) => Promise<unknown>;
      kept.set(name, { original, own: Object.hasOwn(subtle, name) });
      Object.defineProperty(subtle, name, {
        configurable: true,
        writable: true,
        value: this.counted((...args: unknown[]) =>
          original.apply(subtle, args),
        ),
      });
    }
    return () => {
      for (const [name, { original, own }] of kept) {
        if (!own) Reflect.deleteProperty(subtle, name);
        else {
          Object.defineProperty(subtle, name, {
            configurable: true,
            writable: true,
            value: original,
          });
        }
      }
    };
  }
}
