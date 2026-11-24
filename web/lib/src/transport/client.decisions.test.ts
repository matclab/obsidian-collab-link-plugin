import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import { type ConfirmedRecord, connectDocument } from "./client.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (...values: number[]) => new Uint8Array(values);

async function peer(
  server: FakeServer,
  key: CryptoKey,
  content = new LoroDoc(),
) {
  const confirmed: ConfirmedRecord[] = [];
  const connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc-1",
    key,
    credentials: EDITOR,
    channels: [{ channel: "content", doc: content }],
    decisions: { onConfirmed: (batch) => confirmed.push(...batch) },
    socketFactory: () => server.connect(),
  });
  return { connection, confirmed, content };
}

const seqs = (records: ConfirmedRecord[]) => records.map((r) => r.seq);
const payloads = (records: ConfirmedRecord[]) =>
  records.map((r) => [...r.record]);

describe("connectDocument — decisions channel", () => {
  test("a published record is confirmed at every peer, the publisher included, with the same seq", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);

    a.connection.publishDecision(bytes(1, 2));
    await eventually(() => a.confirmed.length > 0 && b.confirmed.length > 0);

    expect(payloads(a.confirmed)).toEqual([[1, 2]]);
    expect(payloads(b.confirmed)).toEqual([[1, 2]]);
    expect(seqs(a.confirmed)).toEqual(seqs(b.confirmed));

    a.connection.close();
    b.connection.close();
  });

  test("a pushed record is only a signal: it is confirmed through a rejoin of the decisions channel", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);
    const joinsBefore = server.joinRequests.filter(
      (r) => r.channel === "decisions",
    ).length;

    a.connection.publishDecision(bytes(7));
    await eventually(() => a.confirmed.length > 0 && b.confirmed.length > 0);

    const decisionJoins = server.joinRequests.filter(
      (r) => r.channel === "decisions",
    );
    // one rejoin for A (its ack), one for B (the push)
    expect(decisionJoins.length).toBe(joinsBefore + 2);
    expect(payloads(b.confirmed)).toEqual([[7]]);

    a.connection.close();
    b.connection.close();
  });

  test("a peer joining later gets every earlier record, once, in seq order", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    a.connection.publishDecision(bytes(1));
    a.connection.publishDecision(bytes(2));
    a.connection.publishDecision(bytes(3));
    await eventually(() => a.confirmed.length === 3);

    const late = await peer(server, key);

    expect(payloads(late.confirmed)).toEqual([[1], [2], [3]]);
    const lateSeqs = seqs(late.confirmed);
    expect(lateSeqs).toEqual([...lateSeqs].sort((x, y) => x - y));
    expect(payloads(a.confirmed)).toEqual([[1], [2], [3]]);

    a.connection.close();
    late.connection.close();
  });

  test("a record published while offline is sent once reconnected", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);

    server.disconnectAll();
    a.connection.publishDecision(bytes(4));
    await eventually(() => a.confirmed.length > 0 && b.confirmed.length > 0); // past the reconnect delay

    expect(payloads(a.confirmed)).toEqual([[4]]);
    expect(payloads(b.confirmed)).toEqual([[4]]);

    a.connection.close();
    b.connection.close();
  });

  test("a record published right after a drop, before the reconnect, is not stuck forever", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);

    server.disconnectAll();
    await settle(50); // the drop is known, the reconnect not yet due
    a.connection.publishDecision(bytes(5));
    await eventually(() => b.confirmed.length === 1); // past the reconnect delay
    a.connection.publishDecision(bytes(6));
    await eventually(() => b.confirmed.length === 2);

    expect(payloads(b.confirmed)).toEqual([[5], [6]]);

    a.connection.close();
    b.connection.close();
  });

  // lastSeq (the shared resume cursor) advances on acks; a decisions record
  // pushed but held back (never imported: pushes are mere signals) would be
  // skipped for good by a rejoin using it. The decisions channel must
  // resume from what a history reply actually confirmed.
  test("after a reconnect, the decisions channel resumes from its confirmed cursor, not the ack-advanced one", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);

    server.pauseDelivery(); // B's decision push to A is held back
    b.connection.publishDecision(bytes(9));
    await eventually(() => b.confirmed.length > 0);
    a.content.getText("content").insert(0, "x"); // A's own ack: seq above B's record
    a.content.commit();
    await eventually(() => server.journaled("doc-1") >= 2);
    server.disconnectAll(); // the held push is never delivered to this socket
    await eventually(() => a.confirmed.length > 0); // past the reconnect delay

    expect(payloads(a.confirmed)).toEqual([[9]]);

    a.connection.close();
    b.connection.close();
  });

  test("the content channel still works next to decisions", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const a = await peer(server, key);
    const b = await peer(server, key);

    a.content.getText("content").insert(0, "hi");
    a.content.commit();
    await eventually(() => b.content.getText("content").toString() === "hi");

    expect(b.content.getText("content").toString()).toBe("hi");
    expect(b.confirmed).toEqual([]);

    a.connection.close();
    b.connection.close();
  });
});
