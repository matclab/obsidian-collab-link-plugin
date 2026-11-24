/** The round of « Mes documents » (ADR-0060 §2): what awaits my reply in the
 * documents opened most recently, one
 * after the other, when the list opens, then every 15 minutes while the
 * page is visible. One round at a time (NT4); the list read again before
 * each document, so that one excluded or deleted meanwhile is skipped
 * (NT2). Counting a document is `count`'s (`countAwaiting`). */
import type { KeyringEntry } from "../../lib/src/index.js";
import { visibleEntries } from "./list-model.js";

/** Documents read in a round, at most (NQ1). */
export const ROUND_SIZE = 10;
/** Between the end of a round and the next (NQ1). */
export const ROUND_EVERY_MS = 15 * 60 * 1000;

export interface RoundOptions {
  /** The list as it stands. */
  entries(): readonly KeyringEntry[];
  /** What awaits my reply in a document; none: not known. `stopped`
   * says it is no longer wanted. */
  count(
    entry: KeyringEntry,
    stopped: () => boolean,
  ): Promise<number | undefined>;
  /** A document's count, as the round found it. */
  shown(documentId: string, count: number | undefined): void;
  visible(): boolean;
  /** Told when `visible()` may have changed; gives its removal. */
  onVisible(listener: () => void): () => void;
  setTimer(run: () => void, ms: number): () => void;
  now(): number;
}

/** The documents a round reads, in their order: the most recently opened,
 * neither excluded nor deleted nor renewed. */
export function roundEntries(entries: readonly KeyringEntry[]): KeyringEntry[] {
  return visibleEntries(entries, { filter: "", sort: "recent" })
    .filter((entry) => entry.state === "ok" && entry.openedAt !== null)
    .slice(0, ROUND_SIZE);
}

export function startAwaitingRound(options: RoundOptions): { stop(): void } {
  let stopped = false;
  let running = false;
  /** When the last round ended; none yet. */
  let ended: number | undefined;
  let cancelTimer = () => {};

  const still = (documentId: string) =>
    options
      .entries()
      .find((entry) => entry.documentId === documentId && !entry.excluded);

  const run = async () => {
    if (stopped || running || !options.visible()) return;
    running = true;
    cancelTimer();
    try {
      for (const { documentId } of roundEntries(options.entries())) {
        if (stopped || !options.visible()) break;
        const entry = still(documentId);
        if (!entry || entry.state !== "ok") continue;
        let count: number | undefined;
        try {
          count = await options.count(entry, () => stopped);
        } catch {
          count = undefined;
        }
        if (stopped) return;
        options.shown(documentId, count);
      }
    } finally {
      running = false;
    }
    if (stopped) return;
    ended = options.now();
    cancelTimer = options.setTimer(() => void run(), ROUND_EVERY_MS);
  };

  const stopVisible = options.onVisible(() => {
    if (
      !running &&
      options.visible() &&
      (ended === undefined || options.now() - ended >= ROUND_EVERY_MS)
    ) {
      void run();
    }
  });
  void run();
  return {
    stop() {
      stopped = true;
      cancelTimer();
      stopVisible();
    },
  };
}
