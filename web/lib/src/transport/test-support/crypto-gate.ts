// Holds every encryption and decryption of the transport until the test
// releases it: the order in which they complete becomes a choice of the
// test, like the order of deliveries in ScheduledServer. WebCrypto makes
// no promise about it (two decryptions started in order may end in the
// other), and without the gate `settle` lets them all finish between two
// steps — no drop, no delivery ever happens while one is in progress.
//
// Installed with `vi.mock` on `crypto/aead.js` (`wrap`); transparent until
// `start`.

interface Held {
  id: number;
  label: string;
  release: () => void;
}

export class CryptoGate {
  private active = false;
  private nextId = 0;
  /** Work done, waiting to be released — ordered by start, so that a
   * choice among them doesn't depend on which one the machine finished
   * first. */
  readonly held: Held[] = [];
  /** Started and not yet done: the only work a test must wait for — the
   * rest runs in microtasks, or waits for the test (held, or a delivery). */
  running = 0;
  /** Each `start` its own: work started before it — by a test case that
   * ended, its page still about — is neither counted nor held. */
  private generation = 0;

  start(): void {
    this.generation++;
    this.active = true;
    this.nextId = 0;
    this.running = 0;
  }

  /** Releases everything and lets later work through. */
  stop(): void {
    this.active = false;
    for (const held of this.held.splice(0)) held.release();
  }

  release(held: Held): void {
    const at = this.held.indexOf(held);
    if (at < 0) return;
    this.held.splice(at, 1);
    held.release();
  }

  wrap<A extends unknown[], R>(
    label: string,
    work: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      if (!this.active) return work(...args);
      const generation = this.generation;
      const id = this.nextId++; // at the call: its order is deterministic
      this.running++;
      const outcome = await work(...args).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (generation !== this.generation) {
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      }
      this.running--;
      if (this.active) {
        await new Promise<void>((release) => {
          const at = this.held.findIndex((held) => held.id > id);
          const held = { id, label: `${label} #${id}`, release };
          if (at < 0) this.held.push(held);
          else this.held.splice(at, 0, held);
        });
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    };
  }
}

export const cryptoGate = new CryptoGate();
