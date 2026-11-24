// The protocol version and the extension rule on the client side
// (docs/phase-8-protocole-ouvert.md, analysis 8b.1): the client says
// which version it speaks and holds the server to it; it ignores what a
// later extension of the server may send, without ever pairing it with a
// frame of its own; it doesn't reconnect after a refusal it doesn't know.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { CloseCode, PROTOCOL_VERSION } from "./protocol.js";
import type { SocketLike } from "./socket.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import {
  ScheduledServer,
  type ScheduledSocket,
} from "./test-support/scheduled-server.js";

const key = await generateKey();

async function connectEditor(server: ScheduledServer) {
  const doc = new LoroDoc();
  const sockets: ScheduledSocket[] = [];
  const result = {
    doc,
    sockets,
    acked: 0,
    refused: [] as number[],
    ready: false,
    failed: undefined as unknown,
    activity: new ActivityCount(),
  };
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
    reconnectDelayMs: 0,
    publishIntervalMs: 0,
    onAcked: () => result.acked++,
    onRefused: (code) => result.refused.push(code),
    activity: result.activity,
  }).then(
    () => {
      result.ready = true;
    },
    (error) => {
      result.failed = error;
    },
  );
  return result;
}

describe("protocol version (phase 8, N1, N2)", () => {
  test("sends its version in `auth`", async () => {
    const server = new ScheduledServer();
    const client = await connectEditor(server);
    const socket = client.sockets[0] as ScheduledSocket;
    socket.deliver("replies"); // open: the client authenticates

    expect(socket.version).toBe(PROTOCOL_VERSION);
  });

  test("refuses a server that holds it to another version, for good", async () => {
    const sockets: SocketLike[] = [];
    const activity = new ActivityCount();
    const connecting = connectDocument({
      activity,
      url: "stub://",
      documentId: "doc",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc: new LoroDoc() }],
      reconnectDelayMs: 0,
      socketFactory: () => {
        const socket: SocketLike = {
          onopen: null,
          onmessage: null,
          onclose: null,
          send: () =>
            socket.onmessage?.({
              data: JSON.stringify({
                authenticated: "edit",
                generation: 1,
                expires_at: null,
                v: PROTOCOL_VERSION + 1,
              }),
            }),
          close: () => socket.onclose?.({ code: 1000 }),
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });

    await expect(connecting).rejects.toMatchObject({
      code: CloseCode.UnsupportedVersion,
    });
    await activity.settled();
    expect(sockets).toHaveLength(1);
  });
});

describe("extension rule (phase 8, N4)", () => {
  test("a message it doesn't know is ignored, never taken for the ack of its frame", async () => {
    const server = new ScheduledServer();
    const client = await connectEditor(server);
    const socket = client.sockets[0] as ScheduledSocket;
    for (let i = 0; i < 3; i++) socket.deliver("replies"); // open, auth, history
    await eventually(() => client.ready);

    client.doc.getText("content").insert(0, "a");
    client.doc.commit();
    await eventually(() => server.journal.length === 1);
    // Sent by the server before it handled the frame: ahead of the ack.
    socket.replies.unshift(
      {
        data: JSON.stringify({
          receipt: "content",
          channel: "content",
          seq: 9,
        }),
      },
      { data: JSON.stringify({ channel: "content", seq: 9 }) },
      { data: JSON.stringify({ notice: "hello", expires_at: 5 }) },
    );
    socket.pushes.push({ data: new Uint8Array([9, 1, 2, 3]).buffer });
    for (let i = 0; i < 3; i++) socket.deliver("replies");
    socket.deliver("pushes");
    await client.activity.settled();
    expect(client.acked).toBe(0);

    socket.deliver("replies"); // the ack
    await eventually(() => client.acked === 1);
    expect(server.closes).toEqual([]);
    expect(client.sockets).toHaveLength(1);
  });
});

describe("close codes it doesn't know (phase 8, N5)", () => {
  test.each([[CloseCode.UnsupportedVersion], [4499]])(
    "a refusal (%i) before the first reply fails the connection, without reconnecting",
    async (code) => {
      const server = new ScheduledServer();
      server.authRefusal = code;
      const client = await connectEditor(server);
      const socket = client.sockets[0] as ScheduledSocket;
      socket.deliver("replies"); // open: the client authenticates
      socket.deliver("replies"); // close

      await eventually(() => client.failed !== undefined);
      expect(client.failed).toMatchObject({ code });
      await client.activity.settled();
      expect(client.sockets).toHaveLength(1);
    },
  );

  test("after the connection is up too, and a close outside 44xx is retried", async () => {
    const server = new ScheduledServer();
    const client = await connectEditor(server);
    const first = client.sockets[0] as ScheduledSocket;
    for (let i = 0; i < 3; i++) first.deliver("replies");
    await eventually(() => client.ready);

    first.replies.push({ close: 1012 }); // service restart
    first.deliver("replies");
    await eventually(() => client.sockets.length === 2);
    const second = client.sockets[1] as ScheduledSocket;
    for (let i = 0; i < 3; i++) second.deliver("replies");
    server.refuse(second, 4499);
    second.deliver("replies");
    await eventually(() => client.refused.length === 1);

    expect(client.refused).toEqual([4499]);
    await client.activity.settled();
    expect(client.sockets).toHaveLength(2);
  });
});

// docs/phase-8-protocole-ouvert.md, G1: a known message the client can't
// read, or an ack or a history reply it isn't waiting for, means the
// pairing by position can no longer be trusted: the client closes and
// resumes, publishing again what wasn't acked.
describe("a server message it can't pair (G1)", () => {
  async function writing() {
    const server = new ScheduledServer();
    const client = await connectEditor(server);
    const socket = client.sockets[0] as ScheduledSocket;
    for (let i = 0; i < 3; i++) socket.deliver("replies"); // open, auth, history
    await eventually(() => client.ready);
    client.doc.getText("content").insert(0, "a");
    client.doc.commit();
    await eventually(() => server.journal.length === 1);
    return { server, client, socket };
  }

  test.each([
    ["a malformed ack", { ack: "content", seq: "1" }],
    ["two keys at once", { ack: "content", seq: 1, rotated: 2 }],
    [
      "the ack of another channel than the frame in flight",
      { ack: "annotations", seq: 9 },
    ],
    ["a history reply to no join", { history: [] }],
  ])("%s: closes, reconnects, and nothing is lost", async (_, json) => {
    const { server, client, socket } = await writing();
    socket.replies.unshift({ data: JSON.stringify(json) });

    socket.deliver("replies");
    await eventually(() => client.sockets.length === 2);
    expect(client.acked).toBe(0);
    const second = client.sockets[1] as ScheduledSocket;
    for (let i = 0; i < 4; i++) {
      await eventually(() => second.replies.length > 0);
      second.deliver("replies"); // open, auth, history, then the ack
    }
    await eventually(() => client.acked === 1);
    expect(server.closes).toEqual([]);
    expect(client.refused).toEqual([]);
  });

  // H1: an entry of another channel than the join answered means the
  // pairing is wrong; imported, it would move that channel's cursor past
  // entries never seen.
  test("a history reply with an entry of another channel than its join: closes and reconnects", async () => {
    const server = new ScheduledServer();
    const client = await connectEditor(server);
    const socket = client.sockets[0] as ScheduledSocket;
    socket.deliver("replies"); // open
    socket.deliver("replies"); // authenticated: the client joins content
    socket.replies.shift(); // the real history reply, replaced by:
    socket.replies.unshift({
      data: JSON.stringify({
        history: [{ channel: "annotations", seq: 5, blob: "AAAA" }],
      }),
    });

    socket.deliver("replies");
    await eventually(() => client.sockets.length === 2);
  });

  test("an ack with no frame in flight: closes and reconnects", async () => {
    const { client, socket } = await writing();
    socket.deliver("replies"); // the real ack
    await eventually(() => client.acked === 1);
    socket.replies.push({ data: JSON.stringify({ ack: "content", seq: 99 }) });

    socket.deliver("replies");
    await eventually(() => client.sockets.length === 2);
  });
});
