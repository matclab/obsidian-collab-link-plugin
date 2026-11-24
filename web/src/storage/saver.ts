import type { LocalRecord } from "./record.js";

export const DEFAULT_SAVE_DELAY_MS = 1000;

/** When to save the local record (ADR-0022 §2): at most `delayMs` after a
 * change — steady typing still saves every `delayMs` —, at once on
 * `flush` (the page is hidden or closing), and one save at a time (R-L2):
 * the record is captured when a save starts, so records reach the store
 * in capture order, and a change made during a save is saved after it. */
export class Saver {
  private readonly capture: () => LocalRecord;
  private readonly save: (record: LocalRecord) => Promise<void>;
  private readonly delayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly activity: { begin(): void; end(): void };
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Changed since the last capture. */
  private dirty = false;
  private saving = false;
  /** A flush asked for while saving: save again as soon as it's done. */
  private flushAfter = false;
  private closed = false;
  /** The save under way, chained flush included. */
  private running: Promise<void> | undefined;

  constructor(options: {
    capture: () => LocalRecord;
    save: (record: LocalRecord) => Promise<void>;
    delayMs?: number;
    /** A save failed (quota, storage gone): the previous record stays. */
    onError?: (error: unknown) => void;
    /** For the tests: a save waiting or under way, counted. */
    activity?: { begin(): void; end(): void };
  }) {
    this.capture = options.capture;
    this.save = options.save;
    this.delayMs = options.delayMs ?? DEFAULT_SAVE_DELAY_MS;
    this.onError = options.onError ?? (() => {});
    this.activity = options.activity ?? { begin() {}, end() {} };
  }

  /** Something the record holds may have changed. */
  changed(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer === undefined && !this.saving) this.schedule();
  }

  /** Saves now, if anything changed. */
  flush(): void {
    if (this.closed || !this.dirty) return;
    this.cancelTimer();
    if (this.saving) this.flushAfter = true;
    else void this.track(this.run());
  }

  close(): void {
    this.closed = true;
    this.cancelTimer();
  }

  /** Saves what changed and closes, resolving once nothing is being saved:
   * the save under way, then one with what changed during it — which
   * `close` alone drops. A failed save is reported, not tried again. For
   * a view that closes while its process lives on (the Obsidian plugin): its
   * lock is released after. */
  async drain(): Promise<void> {
    if (this.closed) return;
    this.cancelTimer();
    // `run` may chain a flush asked for during it: wait for all of it.
    while (this.running) await this.running;
    if (this.dirty && !this.closed) await this.track(this.run(true));
    this.close();
  }

  private schedule(): void {
    this.activity.begin();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.track(this.run());
      this.activity.end();
    }, this.delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.activity.end();
  }

  private track(run: Promise<void>): Promise<void> {
    this.activity.begin();
    const tracked = run.finally(() => {
      this.activity.end();
      if (this.running === tracked) this.running = undefined;
    });
    this.running = tracked;
    return tracked;
  }

  /** `last`: the drain's own, which chains nothing after it. */
  private async run(last = false): Promise<void> {
    if (this.closed) return;
    this.saving = true;
    this.dirty = false;
    let failed = false;
    try {
      await this.save(this.capture());
    } catch (error) {
      failed = true;
      this.dirty = true; // not saved: the next change or flush tries again
      this.onError(error);
    } finally {
      this.saving = false;
    }
    if (last) return;
    if (this.flushAfter) {
      this.flushAfter = false;
      this.flush();
    } else if (this.dirty && this.timer === undefined && !failed) {
      this.schedule();
    }
  }
}
