import type { LoroDoc } from "loro-crdt";
import {
  type ConfirmedRecord,
  type DocumentConnection,
  type TransportState,
  idsWithStatus,
} from "../../lib/src/index.js";
import { count } from "../perf/index.js";
import { type LocalRecord, type LocalState, Saver } from "../storage/index.js";
import type { SetAside } from "../view-model/set-aside.js";

export type LocalOwner = Extract<LocalState, { kind: "owner" }>;

type Docs = Record<"content" | "annotations", LoroDoc>;

/** Whether an annotation is still open: what is set aside is kept for
 * those only (ADR-0050 §4). */
function isOpen(annotationsDoc: LoroDoc): (id: string) => boolean {
  const open = new Set(
    idsWithStatus(annotationsDoc, "open", [
      "addition",
      "deletion",
      "substitution",
      "comment",
    ]),
  );
  return (id) => open.has(id);
}

/** The transport's part of a stored record: what `resume` takes. */
export function resumeFrom(record: LocalRecord): TransportState {
  return {
    channels: record.channels.map(({ snapshot: _, ...state }) => state),
    decisions: {
      cursor: record.decisions.cursor,
      outbox: record.decisions.outbox,
    },
  };
}

/** What this page holds that the server hasn't acked: its own Loro
 * operations (one per character typed), adopted changes and decisions —
 * what only this browser has. A measure of "anything left", not a number
 * of edits to show. */
export function unsentCount(state: TransportState, docs: Docs): number {
  let unsent = state.decisions.outbox.length;
  for (const channel of state.channels) {
    const version = docs[channel.channel].oplogVersion();
    for (const { peer, acked } of channel.own) {
      unsent += (version.get(peer as `${number}`) ?? 0) - acked;
    }
    unsent += channel.adopted.length;
  }
  return unsent;
}

/** Keeps the page's record up to date (ADR-0022 §2): saved after any
 * change of either doc (local or imported), and after what the caller
 * reports with `changed` — a decision sent or confirmed, an ack. Missing a
 * trigger only leaves the record older: a longer rejoin, a harmless
 * duplicate. The docs, the transport and the confirmed decisions are read
 * in one turn (phase 7, L2). */
export function persistLocally(options: {
  owner: LocalOwner;
  docs: Docs;
  connection: DocumentConnection;
  /** The confirmed decisions so far, a gapless prefix; the caller appends
   * to it. */
  confirmed: readonly ConfirmedRecord[];
  /** What I set aside (ADR-0050 §4): kept for the open annotations;
   * saved after each change. */
  setAside?: SetAside;
  delayMs?: number;
  onUnsent?: (count: number) => void;
  onError?: (error: unknown) => void;
  /** For the tests: a save waiting or under way, counted. */
  activity?: { begin(): void; end(): void };
}): {
  changed(): void;
  flush(): void;
  close(): void;
  drain(): Promise<void>;
} {
  const { owner, docs, connection, confirmed, onUnsent, setAside } = options;
  const saver = new Saver({
    capture() {
      count("storage.capture");
      const state = connection.persisted();
      onUnsent?.(unsentCount(state, docs));
      return {
        channels: state.channels.map((channel) => ({
          ...channel,
          snapshot: docs[channel.channel].export({ mode: "snapshot" }),
        })),
        decisions: { ...state.decisions, confirmed: [...confirmed] },
        ...(setAside && {
          setAside: setAside.stored(isOpen(docs.annotations)),
        }),
      };
    },
    save: (record) => owner.save(record),
    ...(options.delayMs !== undefined && { delayMs: options.delayMs }),
    ...(options.onError && { onError: options.onError }),
    ...(options.activity && { activity: options.activity }),
  });
  onUnsent?.(unsentCount(connection.persisted(), docs));
  const unsubscribes = [docs.content, docs.annotations].map((doc) =>
    doc.subscribe(() => saver.changed()),
  );
  if (setAside) unsubscribes.push(setAside.subscribe(() => saver.changed()));
  return {
    changed: () => saver.changed(),
    flush: () => saver.flush(),
    close() {
      saver.close();
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
    /** Saves what changed, waits for every save, then closes. */
    async drain() {
      await saver.drain();
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
