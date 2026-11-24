// A write concurrent with a compaction — a frame in flight, or a peer
// offline across it — must stay importable by every client that loads the
// compacted journal. It could not while a compaction wrote a *shallow*
// snapshot at the compacting client's frontier: Loro refused anything that
// depended on history before that root ("The dependencies of the importing
// updates are not included in the shallow history of the doc"). Found by
// publication.property.test.ts; fixed by compacting with a full snapshot
// (ADR-0017).
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { decrypt, generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { importHistory } from "./import-history.js";
import { EDITOR } from "./test-support/credentials.js";
import {
  ScheduledServer,
  type ScheduledSocket,
} from "./test-support/scheduled-server.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Work the clients have in progress (timers, encryption): delivering is
// done once nothing is left to deliver while none is at work.
let busy = 0;
const activity = { begin: () => busy++, end: () => busy-- };

/** Delivers everything but what goes to `offline`, until quiet. */
async function deliverAll(
  server: ScheduledServer,
  offline: ScheduledSocket[] = [],
): Promise<void> {
  for (let quiet = 0; quiet < 2; ) {
    const sockets = server
      .deliverable()
      .filter((socket) => !offline.includes(socket));
    for (const socket of sockets) {
      while (socket.replies.length > 0) socket.deliver("replies");
      while (socket.pushes.length > 0) socket.deliver("pushes");
    }
    await tick();
    quiet = sockets.length === 0 && busy === 0 ? quiet + 1 : 0;
  }
}

describe("compaction and concurrent writes", () => {
  test("a write concurrent with a compaction reaches a newcomer", async () => {
    const key = await generateKey();
    const server = new ScheduledServer();
    const connect = (doc: LoroDoc, compactionThreshold: number) => {
      const sockets: ScheduledSocket[] = [];
      void connectDocument({
        url: "scheduled://",
        documentId: "doc",
        key,
        credentials: EDITOR,
        channels: [{ channel: "content", doc }],
        socketFactory: () => {
          const socket = server.connect() as ScheduledSocket;
          sockets.push(socket);
          return socket;
        },
        compactionThreshold,
        publishIntervalMs: 0,
        reconnectDelayMs: 0,
        activity,
      });
      return sockets;
    };
    const a = new LoroDoc();
    const b = new LoroDoc();
    connect(a, 3);
    const bSockets = connect(b, 1_000_000);
    a.getText("t").insert(0, "shared "); // compacted at once (7 ops)
    a.commit();
    await deliverAll(server);

    // B writes offline, concurrently with what A writes next, and stays
    // offline until A has compacted again.
    bSockets.at(-1)?.drop();
    b.getText("t").insert(0, "B ");
    b.commit();
    for (const letter of "xyz") {
      a.getText("t").insert(a.getText("t").length, letter);
      a.commit();
      await deliverAll(server, bSockets);
    }
    expect(server.journal).toHaveLength(1); // one snapshot, without B's write

    await deliverAll(server); // B comes back and publishes
    expect(server.journal).toHaveLength(2);

    const newcomer = new LoroDoc();
    const updates: Uint8Array[] = [];
    for (const entry of server.journal) {
      updates.push(await decrypt(key, entry.blob));
    }
    let failure: unknown;
    try {
      importHistory(newcomer, updates);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeUndefined();
    expect(newcomer.getText("t").toString()).toContain("B ");
  });
});
