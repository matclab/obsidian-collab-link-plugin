import type { LoroDoc } from "loro-crdt";
import type { Seal } from "../annotations/model.js";
import { registerPeers } from "./tables.js";

export interface Registration {
  stop(): void;
  /** The pseudonym changed: once registered, the page's peers are
   * written again under the new one — every change of this
   * page then shows it in the history. Before, nothing to do. */
  renamed(): void;
}

/** Registers the page's Loro peers under `author()` in the peers table
 * at its first local change — never on opening
 * alone, which adds nothing to the journal (ADR-0015). Only the peers of
 * `channels`, those the role publishes on: what it writes elsewhere stays
 * local, and a reader writes nothing. In a microtask: not from within the
 * Loro event that triggers it. */
export function registerOnFirstEdit(options: {
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  channels: readonly ("content" | "annotations")[];
  author: () => string;
  /** Signs each name (docs/protocol/06-identity.md, ID-9): the names are
   * written once their signatures are made, with them, in one commit
   * (ID-12); not if the registration stopped meanwhile. */
  seal?: (
    peers: readonly string[],
    name: string,
  ) => Promise<ReadonlyMap<string, Seal>>;
}): Registration {
  const { contentDoc, annotationsDoc, channels, author, seal } = options;
  if (channels.length === 0) return { stop() {}, renamed() {} };
  const docs = { content: contentDoc, annotations: annotationsDoc };
  let stopped = false;
  // Signed, one registration after the other: a rename while a signature
  // runs never lands before it, and the last name stays.
  let queue: Promise<void> = Promise.resolve();
  const register = () => {
    const peers = channels.map((channel) => docs[channel].peerIdStr);
    const name = author();
    if (!seal) {
      registerPeers(annotationsDoc, peers, name);
      return;
    }
    const sealing = seal(peers, name).catch(() => new Map<string, Seal>());
    queue = queue.then(async () => {
      const seals = await sealing;
      if (!stopped) registerPeers(annotationsDoc, peers, name, seals);
    });
  };
  let done = false;
  const onBatch = (batch: { by: string }) => {
    if (done || batch.by !== "local") return;
    done = true;
    stop();
    queueMicrotask(register);
  };
  const unsubscribes = [
    contentDoc.subscribe(onBatch),
    annotationsDoc.subscribe(onBatch),
  ];
  function stop(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
  return {
    stop() {
      stopped = true;
      stop();
    },
    renamed() {
      if (done && !stopped) register();
    },
  };
}
