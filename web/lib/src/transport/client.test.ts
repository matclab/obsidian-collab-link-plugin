import { LoroDoc, decodeImportBlobMeta } from "loro-crdt";
import { beforeEach, describe, expect, test } from "vitest";
import { decrypt, generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";
import { ScheduledServer } from "./test-support/scheduled-server.js";

describe("connectDocument", () => {
  test("connecting with no local edits publishes nothing (no spurious empty update)", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const activity = new ActivityCount();
    const connection = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: new LoroDoc() }],
      socketFactory: () => server.connect(),
      activity,
    });
    await activity.settled();

    expect(server.entries("doc-1")).toEqual([]);

    connection.close();
  });

  // The annotations channel's real data lives in a LoroMap
  // (annotations/model.ts's `doc.getMap("annotations")`), not a LoroText —
  // unlike every other test in this file, which uses `getText("content")`
  // on both channels as a stand-in. This is the one test that exercises
  // the real shape, to make sure local-change publishing isn't accidentally
  // scoped to text containers only.
  test("a local edit to a LoroMap-shaped channel (the real shape annotations uses) still gets published", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const annotationsA = new LoroDoc();
    const annotationsB = new LoroDoc();

    const connectionA = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "annotations", doc: annotationsA }],
      socketFactory: () => server.connect(),
    });
    const connectionB = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "annotations", doc: annotationsB }],
      socketFactory: () => server.connect(),
    });

    annotationsA.getMap("annotations").set("a1", "created");
    annotationsA.commit();
    await eventually(
      () => annotationsB.getMap("annotations").get("a1") === "created",
    );

    connectionA.close();
    connectionB.close();
  });

  test("two clients connected to the same document converge after a local edit", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const docA = new LoroDoc();
    const docB = new LoroDoc();

    const connectionA = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docA }],
      socketFactory: () => server.connect(),
    });
    const connectionB = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docB }],
      socketFactory: () => server.connect(),
    });

    docA.getText("content").insert(0, "Hello");
    docA.commit();

    await eventually(() => docB.getText("content").toString() === "Hello");

    connectionA.close();
    connectionB.close();
  });

  test("a client joining after an edit receives it via history replay", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const docA = new LoroDoc();
    const connectionA = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docA }],
      socketFactory: () => server.connect(),
    });
    docA.getText("content").insert(0, "Hello");
    docA.commit();
    await eventually(() => server.journaled("doc-1") >= 1);

    const docB = new LoroDoc();
    const connectionB = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docB }],
      socketFactory: () => server.connect(),
    });

    expect(docB.getText("content").toString()).toBe("Hello");

    connectionA.close();
    connectionB.close();
  });

  test("reconnects after an unexpected disconnect and catches up via full history replay", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const connectionA = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docA }],
      socketFactory: () => server.connect(),
    });
    const connectionB = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docB }],
      socketFactory: () => server.connect(),
    });

    server.disconnectAll();

    docA.getText("content").insert(0, "written while B is offline");
    docA.commit();

    await eventually(
      () => docB.getText("content").toString() === "written while B is offline",
    ); // past the reconnect delay

    connectionA.close();
    connectionB.close();
  });

  test("resumes from its last seen seq instead of replaying full history on reconnect", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const docA = new LoroDoc();
    const connectionA = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docA }],
      socketFactory: () => server.connect(),
    });
    docA.getText("content").insert(0, "first");
    docA.commit();
    await eventually(() => server.journaled("doc-1") >= 1);

    const docB = new LoroDoc();
    const connectionB = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: docB }],
      socketFactory: () => server.connect(),
    });
    expect(docB.getText("content").toString()).toBe("first");

    connectionA.close(); // A leaves cleanly, so it won't reconnect below
    const joinsBeforeDrop = server.joinRequests.length;
    server.disconnectAll(); // drops B's socket without going through close()
    await eventually(() => server.joinRequests.length > joinsBeforeDrop); // B reconnected

    // B's cursor is 1: the "first" entry of its own join reply — a
    // defined cursor, not a full replay (`since` omitted).
    const resumeJoin = server.joinRequests
      .filter((request) => request.documentId === "doc-1")
      .at(-1);
    expect(resumeJoin?.since).toBe(1);

    connectionB.close();
  });

  test("triggers a compaction once its own published op count crosses the threshold", async () => {
    const key = await generateKey();
    const server = new FakeServer();

    const doc = new LoroDoc();
    const activity = new ActivityCount();
    const connection = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc }],
      socketFactory: () => server.connect(),
      compactionThreshold: 3,
      activity,
    });

    const text = doc.getText("content");
    for (let i = 0; i < 3; i++) {
      text.insert(text.length, "x");
      doc.commit();
      await activity.settled();
    }

    expect(server.compactRequests).toHaveLength(1);
    const request = server.compactRequests[0];
    expect(request?.documentId).toBe("doc-1");
    expect(request?.channel).toBe("content");
    expect(request?.upToSeq).toBeGreaterThan(0);
    expect(request?.snapshot.length).toBeGreaterThan(0);

    // The snapshot itself decrypts into a valid Loro update a fresh doc
    // can import, converging on the same content.
    const plaintext = await decrypt(key, request?.snapshot as Uint8Array);
    const replica = new LoroDoc();
    replica.import(plaintext);
    expect(replica.getText("content").toString()).toBe("xxx");

    connection.close();
  });

  test("skips a compaction whose message would exceed the size limit, and keeps publishing", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const doc = new LoroDoc();
    const activity = new ActivityCount();
    const connection = await connectDocument({
      url: "wss://fake/ws",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc }],
      socketFactory: () => server.connect(),
      compactionThreshold: 3,
      maxMessageBytes: 200, // far below any snapshot's message
      activity,
    });

    const text = doc.getText("content");
    for (let i = 0; i < 4; i++) {
      text.insert(text.length, "x");
      doc.commit();
      await activity.settled();
    }
    // The rejoin that precedes a compaction took place (ADR-0011)...
    expect(server.joinRequests.length).toBeGreaterThan(1);
    // ...but the compaction was not sent: the real server would close the
    // connection on it.
    expect(server.compactRequests).toHaveLength(0);
    const replica = new LoroDoc();
    for (const entry of server.entries("doc-1")) {
      replica.import(await decrypt(key, entry.blob));
    }
    expect(replica.getText("content").toString()).toBe("xxxx");

    connection.close();
  });

  describe("multiple channels on one connection", () => {
    test("two channels converge independently between two clients", async () => {
      const key = await generateKey();
      const server = new FakeServer();

      const contentA = new LoroDoc();
      const annotationsA = new LoroDoc();
      const contentB = new LoroDoc();
      const annotationsB = new LoroDoc();

      const connectionA = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc: contentA },
          { channel: "annotations", doc: annotationsA },
        ],
        socketFactory: () => server.connect(),
      });
      const connectionB = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc: contentB },
          { channel: "annotations", doc: annotationsB },
        ],
        socketFactory: () => server.connect(),
      });

      contentA.getText("content").insert(0, "hello content");
      contentA.commit();
      annotationsA.getText("content").insert(0, "hello annotation");
      annotationsA.commit();

      await eventually(
        () =>
          contentB.getText("content").toString() === "hello content" &&
          annotationsB.getText("content").toString() === "hello annotation",
      );

      expect(contentB.getText("content").toString()).toBe("hello content");
      expect(annotationsB.getText("content").toString()).toBe(
        "hello annotation",
      );

      connectionA.close();
      connectionB.close();
    });

    test("an edit on annotations produces no observable change on content, and vice versa", async () => {
      const key = await generateKey();
      const server = new FakeServer();

      const contentA = new LoroDoc();
      const annotationsA = new LoroDoc();
      const contentB = new LoroDoc();
      const annotationsB = new LoroDoc();

      const connectionA = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc: contentA },
          { channel: "annotations", doc: annotationsA },
        ],
        socketFactory: () => server.connect(),
      });
      const connectionB = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc: contentB },
          { channel: "annotations", doc: annotationsB },
        ],
        socketFactory: () => server.connect(),
      });

      const contentVersionBefore = contentB.oplogVersion();

      annotationsA.getText("content").insert(0, "an annotation");
      annotationsA.commit();
      await eventually(
        () => annotationsB.getText("content").toString() === "an annotation",
      );

      expect(annotationsB.getText("content").toString()).toBe("an annotation");
      expect(contentB.oplogVersion().compare(contentVersionBefore)).toBe(0);
      expect(contentB.getText("content").toString()).toBe("");

      const annotationsVersionBefore = annotationsB.oplogVersion();

      contentA.getText("content").insert(0, "some content");
      contentA.commit();
      await eventually(
        () => contentB.getText("content").toString() === "some content",
      );

      expect(contentB.getText("content").toString()).toBe("some content");
      expect(
        annotationsB.oplogVersion().compare(annotationsVersionBefore),
      ).toBe(0);

      connectionA.close();
      connectionB.close();
    });

    test("each channel resumes from its own confirmed cursor, never from an ack (ADR-0015)", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const writer = new LoroDoc();
      const writing = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [{ channel: "content", doc: writer }],
        socketFactory: () => server.connect(),
      });
      writer.getText("content").insert(0, "x");
      writer.commit();
      await eventually(() => server.journaled("doc-1") === 1);
      writing.close();

      const doc = new LoroDoc();
      const annotations = new LoroDoc();
      const connection = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc },
          { channel: "annotations", doc: annotations },
        ],
        socketFactory: () => server.connect(),
      });
      // Content was confirmed up to seq 1 by the history reply; this
      // client's own publish is acked as seq 2, which confirms nothing.
      doc.getText("content").insert(1, "y");
      doc.commit();
      await eventually(() => server.journaled("doc-1") === 2);

      const joinsBeforeDrop = server.joinRequests.length;
      server.disconnectAll();
      await eventually(() => server.joinRequests.length >= joinsBeforeDrop + 2);

      const resumed = server.joinRequests.slice(joinsBeforeDrop);
      expect(resumed.find((join) => join.channel === "content")?.since).toBe(1);
      expect(
        resumed.find((join) => join.channel === "annotations")?.since,
      ).toBeUndefined();

      connection.close();
    });

    test("each channel tracks its own compaction threshold independently", async () => {
      const key = await generateKey();
      const server = new FakeServer();

      const doc = new LoroDoc();
      const annotations = new LoroDoc();
      const activity = new ActivityCount();
      const connection = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [
          { channel: "content", doc },
          { channel: "annotations", doc: annotations },
        ],
        socketFactory: () => server.connect(),
        compactionThreshold: 3,
        activity,
      });

      // Only annotations crosses the threshold.
      const annotationsText = annotations.getText("content");
      for (let i = 0; i < 3; i++) {
        annotationsText.insert(annotationsText.length, "a");
        annotations.commit();
        await activity.settled();
      }

      expect(server.compactRequests).toHaveLength(1);
      expect(server.compactRequests[0]?.channel).toBe("annotations");

      connection.close();
    });
  });

  describe("ADR-0011: compaction re-joins before compacting, never trusting an ack alone", () => {
    test("resyncs via rejoin before compacting, so a peer's earlier op delayed in flight is never lost", async () => {
      const key = await generateKey();
      const server = new FakeServer();

      const docA = new LoroDoc();
      const docC = new LoroDoc();

      const connectionA = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [{ channel: "content", doc: docA }],
        socketFactory: () => server.connect(),
        compactionThreshold: 1,
      });
      const connectionC = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [{ channel: "content", doc: docC }],
        socketFactory: () => server.connect(),
      });

      server.pauseDelivery();

      // C publishes; the journal now has this op (seq 1), but its live
      // push to A is held back — simulating tokio::select!'s lack of
      // ordering guarantee between "flush a pending push" and "handle A's
      // own incoming publish + send its ack" on A's real connection
      // (docs/adr/0011-*.md).
      docC.getText("content").insert(0, "from C");
      docC.commit();
      await eventually(() => server.journaled("doc-1") >= 1);

      // A publishes independently (seq 2) and gets its own ack right away
      // — that ack alone must never be trusted as proof A has imported
      // C's op. With compactionThreshold 1, this also triggers A's
      // compaction attempt.
      docA.getText("content").insert(0, "from A");
      docA.commit();
      await eventually(() =>
        server.compactRequests.some((request) => request.upToSeq >= 2),
      );

      // A must have re-joined (a fresh HistoryReply) before compacting —
      // never relying on lastSeq/its own ack.
      const contentJoins = server.joinRequests.filter(
        (request) =>
          request.documentId === "doc-1" && request.channel === "content",
      );
      const resyncJoin = contentJoins.find((request) => request.since === 0);
      expect(resyncJoin).toBeDefined();

      // At least one compaction attempt must have happened (a rejoin
      // importing foreign content can itself make `publishPending` see
      // more to flush and re-ack, occasionally triggering another
      // threshold crossing — harmless, since every attempt independently
      // re-syncs first; what matters is that none of them ever lose data).
      expect(server.compactRequests.length).toBeGreaterThanOrEqual(1);
      const request = server.compactRequests.at(-1);
      expect(request?.upToSeq).toBeGreaterThanOrEqual(2);

      // The exported snapshot must include C's op even though its live
      // push was still held back at compaction time — the client can only
      // have gotten it through the ADR-0011 rejoin.
      const plaintext = await decrypt(key, request?.snapshot as Uint8Array);
      const replica = new LoroDoc();
      replica.import(plaintext);
      expect(replica.getText("content").toString()).toContain("from C");
      expect(replica.getText("content").toString()).toContain("from A");

      server.resumeDelivery();
      await eventually(() =>
        docA.getText("content").toString().includes("from C"),
      );

      // The now-delivered, delayed push is a harmless no-op (already
      // imported via the rejoin) — A's doc still converges correctly.
      expect(docA.getText("content").toString()).toContain("from C");
      expect(docA.getText("content").toString()).toContain("from A");

      connectionA.close();
      connectionC.close();
    });
  });

  describe("publication: only one's own operations, grouped (ADR-0015)", () => {
    async function connect(
      server: FakeServer,
      key: CryptoKey,
      doc = new LoroDoc(),
      options: { compactionThreshold?: number } = {},
    ) {
      const activity = new ActivityCount();
      counts.push(activity);
      const connection = await connectDocument({
        url: "wss://fake/ws",
        documentId: "doc-1",
        key,
        credentials: EDITOR,
        channels: [{ channel: "content", doc }],
        socketFactory: () => server.connect(),
        activity,
        ...options,
      });
      return { doc, connection };
    }
    /** What the peers of a test have in progress. */
    const counts: ActivityCount[] = [];
    beforeEach(() => {
      counts.length = 0;
    });
    /** Until none of them has anything in progress: one's message may set
     * another to work. */
    const settle = async () => {
      do {
        for (const count of counts) await count.settled();
      } while (counts.some((count) => count.inProgress > 0));
    };
    const type = (doc: LoroDoc, text: string) => {
      const content = doc.getText("content");
      content.insert(content.length, text);
      doc.commit();
    };

    /** The Loro peers whose operations a journal entry carries. */
    async function authorsOf(key: CryptoKey, blob: Uint8Array) {
      const meta = decodeImportBlobMeta(await decrypt(key, blob), false);
      const start = meta.partialStartVersionVector.toJSON();
      return [...meta.partialEndVersionVector.toJSON()]
        .filter(([peer, end]) => end > (start.get(peer) ?? 0))
        .map(([peer]) => peer);
    }

    test("opening a document adds no entry to its journal", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const a = await connect(server, key);
      type(a.doc, "hello");
      await eventually(() => server.journaled("doc-1") === 1);

      const b = await connect(server, key);
      await settle();

      expect(b.doc.getText("content").toString()).toBe("hello");
      expect(server.journaled("doc-1")).toBe(1);
      a.connection.close();
      b.connection.close();
    });

    test("every entry carries its author's operations only, however many peers are connected", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const peers = [
        await connect(server, key),
        await connect(server, key),
        await connect(server, key),
      ];
      let journaled = 0;
      for (let round = 0; round < 3; round++) {
        for (const [i, peer] of peers.entries()) {
          type(peer.doc, String(i));
          // Journaled before the next write: a fixed wait could let two
          // writes of a slow machine group into one frame.
          await eventually(() => server.journaled("doc-1") === journaled + 1);
          journaled++;
        }
      }
      await eventually(() =>
        peers.every((peer) => peer.doc.getText("content").length === 9),
      );

      const entries = server.entries("doc-1");
      expect(entries).toHaveLength(9);
      for (const entry of entries) {
        expect(await authorsOf(key, entry.blob)).toHaveLength(1);
      }
      for (const peer of peers) peer.connection.close();
    });

    test("commits made in one go leave in one frame", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const a = await connect(server, key);

      for (let i = 0; i < 20; i++) type(a.doc, "x");
      await settle();

      expect(server.journaled("doc-1")).toBe(1);
      a.connection.close();
    });

    test("no operation is lost when the connection drops while commits wait or a frame is in flight", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const a = await connect(server, key);
      type(a.doc, "a");
      type(a.doc, "b"); // waiting to be sent
      server.disconnectAll();
      type(a.doc, "c"); // offline
      await eventually(() => server.journaled("doc-1") > 0, 3000);

      const b = await connect(server, key);
      await eventually(
        () => b.doc.getText("content").toString() === "abc",
        3000,
      );
      a.connection.close();
      b.connection.close();
    });

    test("a peer's frame still queued for delivery when the connection drops arrives after the reconnect", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const a = await connect(server, key);
      const c = await connect(server, key);

      // docs/adr/0011-*.md's race: C's frame is journaled (seq 1) but its
      // push to A is still queued when A's own publish is acked (seq 2),
      // then A's connection drops before the push is delivered.
      server.pauseDelivery();
      type(c.doc, "from C ");
      await eventually(() => server.journaled("doc-1") === 1);
      type(a.doc, "from A");
      await eventually(() => server.journaled("doc-1") === 2);
      c.connection.close(); // C leaves: nobody is left to publish it again
      server.disconnectAll();
      server.resumeDelivery(); // dropped with A's dead connection

      await eventually(
        () => a.doc.getText("content").toString().includes("from C"),
        3000,
      );
      a.connection.close();
    });

    test("a compaction threshold counts operations, not frames", async () => {
      const key = await generateKey();
      const server = new FakeServer();
      const a = await connect(server, key, new LoroDoc(), {
        compactionThreshold: 5,
      });

      for (let i = 0; i < 5; i++) type(a.doc, "x"); // one frame, five ops
      await eventually(() => server.compactRequests.length > 0);

      expect(server.journaled("doc-1")).toBe(1);
      a.connection.close();
    });
  });

  test("still resolves when its first connection drops before every history reply arrived", async () => {
    const key = await generateKey();
    const server = new ScheduledServer();
    const doc = new LoroDoc();
    let resolved = false;
    void connectDocument({
      url: "scheduled://",
      documentId: "doc-1",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc }],
      socketFactory: () => server.connect(),
      reconnectDelayMs: 0,
    }).then(() => {
      resolved = true;
    });
    server.sockets[0]?.deliver("replies"); // open: the join is sent
    server.sockets[0]?.drop(); // before its reply

    await eventually(() => {
      for (const socket of server.deliverable()) {
        while (socket.replies.length > 0) socket.deliver("replies");
      }
      return resolved;
    });
  });
});
