// Resuming from a record an earlier page stored (ADR-0022): the transport
// state it captures (`persisted`), and a connection built from it
// (`resume`). The snapshots are the caller's; here, as the page does.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { decrypt, encrypt, generateKey } from "../crypto/aead.js";
import {
  type DocumentConnection,
  type TransportState,
  connectDocument,
} from "./client.js";
import type { SocketLike } from "./socket.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";

/** A socket that never opens: the network is down. */
function unreachable(): SocketLike {
  return {
    send() {
      throw new Error("not connected");
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
  };
}

interface Stored {
  snapshot: Uint8Array;
  transport: TransportState;
}

async function setUp() {
  const key = await generateKey();
  const server = new FakeServer();
  const network = { up: true };
  const connections: DocumentConnection[] = [];
  /** What each page has in progress. */
  const counts: ActivityCount[] = [];

  /** A page: a fresh doc (a fresh peer id), filled from `stored` if any. */
  async function page(
    stored?: Stored,
    options: { decisions?: (seqs: number[]) => void } = {},
  ) {
    const doc = new LoroDoc();
    if (stored) doc.import(stored.snapshot);
    const activity = new ActivityCount();
    counts.push(activity);
    const connection = await connectDocument({
      activity,
      url: "wss://fake/ws",
      documentId: "doc",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc }],
      ...(options.decisions && {
        decisions: {
          onConfirmed: (batch) =>
            options.decisions?.(batch.map((entry) => entry.seq)),
        },
      }),
      ...(stored && { resume: stored.transport }),
      socketFactory: () => (network.up ? server.connect() : unreachable()),
      publishIntervalMs: 0,
      reconnectDelayMs: 5,
    });
    connections.push(connection);
    const store = (): Stored => ({
      snapshot: doc.export({ mode: "snapshot" }),
      transport: connection.persisted(),
    });
    return { doc, connection, store };
  }

  function offline(): void {
    network.up = false;
    server.disconnectAll();
  }

  const text = (doc: LoroDoc) => doc.getText("t").toString();
  const type = (doc: LoroDoc, at: number, value: string) => {
    doc.getText("t").insert(at, value);
    doc.commit();
  };
  /** Until no page has anything in progress: one's message may set
   * another to work. */
  const settle = async () => {
    do {
      for (const count of counts) await count.settled();
    } while (counts.some((count) => count.inProgress > 0));
  };
  const close = () => {
    for (const connection of connections) connection.close();
  };

  return { key, server, network, page, offline, text, type, settle, close };
}

describe("resuming from a stored record", () => {
  test("acknowledged: how far the server acked an own peer's operations, after the ack only", async () => {
    const t = await setUp();
    const first = await t.page();
    const peer = first.doc.peerIdStr;
    expect(first.connection.acknowledged("content", peer)).toBe(0);
    t.type(first.doc, 0, "hello");
    const end = first.doc.oplogVersion().get(peer) ?? 0;
    // Committed, not yet sent: the frame leaves on a timer.
    expect(first.connection.acknowledged("content", peer)).toBe(0);
    await eventually(
      () => first.connection.acknowledged("content", peer) >= end,
    );
    expect(t.server.journaled("doc")).toBe(1);
    expect(first.connection.acknowledged("content", "12345")).toBe(0);
    t.close();
  });

  test("edits made offline in a closed page are published by the next one", async () => {
    const t = await setUp();
    const first = await t.page();
    t.offline();
    t.type(first.doc, 0, "written offline");
    const stored = first.store();
    first.connection.close();

    t.network.up = true;
    await t.page(stored);
    const reader = await t.page();
    await eventually(() => t.text(reader.doc) === "written offline");
    t.close();
  });

  test("what the server acked is not stored as pending, nor published again", async () => {
    const t = await setUp();
    const first = await t.page();
    t.type(first.doc, 0, "hello");
    await eventually(() => t.server.journaled("doc") === 1);
    await t.settle(); // the ack
    const stored = first.store();
    expect(stored.transport.channels[0]?.own).toEqual([]); // R-L1: pruned
    first.connection.close();

    await t.page(stored);
    await t.settle();
    expect(t.server.journaled("doc")).toBe(1);
    t.close();
  });

  test("a record older than the ack republishes: a duplicate, harmless", async () => {
    const t = await setUp();
    const first = await t.page();
    t.offline();
    t.type(first.doc, 0, "hello");
    const stale = first.store(); // before the ack
    t.network.up = true;
    await eventually(() => t.server.journaled("doc") === 1);
    first.connection.close();

    await t.page(stale);
    await eventually(() => t.server.journaled("doc") === 2);
    const reader = await t.page();
    await t.settle();
    expect(t.text(reader.doc)).toBe("hello");
    t.close();
  });

  test("rejoins from the stored cursor, not from the start", async () => {
    const t = await setUp();
    const writer = await t.page();
    t.type(writer.doc, 0, "one");
    await eventually(() => t.server.journaled("doc") === 1);
    const first = await t.page();
    const stored = first.store();
    expect(stored.transport.channels[0]?.cursor).toBe(1);
    first.connection.close();

    t.server.joinRequests.length = 0;
    await t.page(stored);
    expect(t.server.joinRequests).toEqual([
      { documentId: "doc", channel: "content", since: 1 },
    ]);
    t.close();
  });

  test("R-L3: the stored cursor stays before operations waiting for a dependency", async () => {
    const t = await setUp();
    // Y depends on X; the journal holds Y first (a writer before R-A1).
    const author = new LoroDoc();
    author.getText("t").insert(0, "X");
    author.commit();
    const x = author.export({ mode: "update" });
    const afterX = author.oplogVersion();
    author.getText("t").insert(1, "Y");
    author.commit();
    const y = author.export({ mode: "update", from: afterX });
    t.server.append("doc", "content", await encrypt(t.key, y));

    const first = await t.page();
    expect(t.text(first.doc)).toBe(""); // Y waits for X
    // Imported up to seq 1, but seq 1 isn't in a snapshot: frozen before.
    expect(first.store().transport.channels[0]?.cursor).toBe(0);

    t.server.append("doc", "content", await encrypt(t.key, x));
    t.server.disconnectAll(); // the reconnection's join brings X
    await eventually(() => t.text(first.doc) === "XY");
    expect(first.store().transport.channels[0]?.cursor).toBe(2);
    t.close();
  });

  test("an adopted change not yet acked is published by the next page, before what was typed after it (R-A1, R-A2)", async () => {
    const t = await setUp();
    const first = await t.page();
    t.type(first.doc, 0, "hello world");
    await eventually(() => t.server.journaled("doc") === 1);
    t.offline();
    // A detached change, adopted, then typing that depends on it.
    const fork = first.doc.fork();
    fork.setPeerId(77n);
    const before = fork.oplogVersion();
    fork.getText("t").insert(5, " dear");
    fork.commit();
    const change = fork.export({ mode: "update", from: before });
    first.doc.import(change);
    first.connection.adopt("content", change);
    t.type(first.doc, 10, "est");
    const stored = first.store();
    expect(stored.transport.channels[0]?.adopted).toHaveLength(1);
    first.connection.close();

    t.network.up = true;
    await t.page(stored);
    await eventually(() => t.server.journaled("doc") === 3);
    const [base, adopted, typed] = t.server.entries("doc");
    if (!base || !adopted || !typed) throw new Error("missing entries");
    // Each entry on top of the first alone: the adopted change applies, the
    // typing waits for it — so it was journaled after it.
    const alone = async (blob: Uint8Array) => {
      const doc = new LoroDoc();
      doc.import(await decrypt(t.key, base.blob));
      doc.import(await decrypt(t.key, blob));
      return t.text(doc);
    };
    expect(await alone(adopted.blob)).toBe("hello dear world");
    expect(await alone(typed.blob)).toBe("hello world");
    const reader = await t.page();
    await eventually(() => t.text(reader.doc) === "hello dearest world");
    t.close();
  });

  test("a decision clicked offline, page closed: sent by the next page", async () => {
    const t = await setUp();
    const first = await t.page(undefined, { decisions: () => {} });
    t.offline();
    first.connection.publishDecision(new TextEncoder().encode("a decision"));
    const stored = first.store();
    expect(stored.transport.decisions.outbox).toHaveLength(1);
    first.connection.close();

    t.network.up = true;
    await t.page(stored, { decisions: () => {} });
    await eventually(() =>
      t.server.entries("doc").some((entry) => entry.channel === "decisions"),
    );
    t.close();
  });

  test("the decisions channel resumes from its stored cursor", async () => {
    const t = await setUp();
    const decider = await t.page(undefined, { decisions: () => {} });
    decider.connection.publishDecision(new TextEncoder().encode("first"));
    await eventually(() => t.server.journaled("doc") === 1);
    const seen: number[] = [];
    const first = await t.page(undefined, {
      decisions: (seqs) => seen.push(...seqs),
    });
    await eventually(() => seen.length === 1);
    const stored = first.store();
    expect(stored.transport.decisions.cursor).toBe(1);
    first.connection.close();

    const again: number[] = [];
    t.server.joinRequests.length = 0;
    await t.page(stored, { decisions: (seqs) => again.push(...seqs) });
    expect(
      t.server.joinRequests.find((join) => join.channel === "decisions")?.since,
    ).toBe(1);
    await t.settle();
    expect(again).toEqual([]); // nothing new, nothing delivered again
    t.close();
  });
});
