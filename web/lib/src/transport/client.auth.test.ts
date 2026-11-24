// Authentication and role rights on the client side (ADR-0019): the
// client authenticates before anything else, publishes only where its role
// may, and reacts to each close code as ADR-0019 §4 says.
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, test, vi } from "vitest";
import { generateKey } from "../crypto/aead.js";
import type { Role } from "../crypto/role-secrets.js";
import { type ConnectOptions, connectDocument } from "./client.js";
import { CloseCode } from "./protocol.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";
import {
  ScheduledServer,
  type ScheduledSocket,
} from "./test-support/scheduled-server.js";

const secret = new Uint8Array(32).fill(1);
const as = (role: Role) => ({ role, secret });
const key = await generateKey();

async function options(
  server: FakeServer,
  role: Role,
  docs: { content?: LoroDoc; annotations?: LoroDoc } = {},
): Promise<ConnectOptions & { sockets: number; activity: ActivityCount }> {
  const result = {
    activity: new ActivityCount(),
    url: "wss://fake/ws",
    documentId: "doc-1",
    key,
    credentials: as(role),
    channels: [
      { channel: "content" as const, doc: docs.content ?? new LoroDoc() },
      {
        channel: "annotations" as const,
        doc: docs.annotations ?? new LoroDoc(),
      },
    ],
    sockets: 0,
    socketFactory: () => {
      result.sockets++;
      return server.connect();
    },
    reconnectDelayMs: 0,
  };
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("authentication (ADR-0019 §3)", () => {
  test("authenticates first, then joins: the server refuses anything else", async () => {
    const server = new ScheduledServer();
    const doc = new LoroDoc();
    let ready = false;
    void connectDocument({
      url: "scheduled://",
      documentId: "doc",
      key: await generateKey(),
      credentials: as("read"),
      channels: [{ channel: "content", doc }],
      socketFactory: () => server.connect(),
    }).then(() => {
      ready = true;
    });
    const socket = server.sockets[0] as ScheduledSocket;
    socket.deliver("replies"); // open: the client sends `auth`
    expect(socket.role).toBe("read");
    expect(socket.channels.size).toBe(0);
    socket.deliver("replies"); // authenticated: the client joins
    expect(socket.channels).toEqual(new Set(["content"]));
    socket.deliver("replies"); // history
    await eventually(() => ready);
    expect(server.closes).toEqual([]);
  });

  test.each([
    [CloseCode.Unauthenticated],
    [CloseCode.Malformed],
    [CloseCode.Forbidden],
    [CloseCode.Revoked],
  ])(
    "a refusal (%i) before the first reply fails the connection, without reconnecting",
    async (code) => {
      const server = new FakeServer();
      server.checkAuth = () => code;
      const opts = await options(server, "edit");

      await expect(connectDocument(opts)).rejects.toMatchObject({ code });
      await opts.activity.settled();
      expect(opts.sockets).toBe(1);
    },
  );

  test("a refusal after the connection is up is reported, and never retried", async () => {
    const server = new ScheduledServer();
    const refused: number[] = [];
    const sockets: ScheduledSocket[] = [];
    const activity = new ActivityCount();
    let ready = false;
    void connectDocument({
      url: "scheduled://",
      documentId: "doc",
      key: await generateKey(),
      credentials: as("edit"),
      channels: [{ channel: "content", doc: new LoroDoc() }],
      socketFactory: () => {
        const socket = server.connect() as ScheduledSocket;
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 0,
      onRefused: (code) => refused.push(code),
      activity,
    }).then(() => {
      ready = true;
    });
    const socket = sockets[0] as ScheduledSocket;
    for (let i = 0; i < 3; i++) socket.deliver("replies");
    await eventually(() => ready);

    server.refuse(socket, CloseCode.Revoked);
    socket.deliver("replies");
    await activity.settled();

    expect(refused).toEqual([CloseCode.Revoked]);
    expect(sockets).toHaveLength(1);
  });

  test("reconnects after a drop and after 4408 (too slow)", async () => {
    const server = new ScheduledServer();
    const sockets: ScheduledSocket[] = [];
    void connectDocument({
      url: "scheduled://",
      documentId: "doc",
      key: await generateKey(),
      credentials: as("read"),
      channels: [{ channel: "content", doc: new LoroDoc() }],
      socketFactory: () => {
        const socket = server.connect() as ScheduledSocket;
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 0,
    });
    const first = sockets[0] as ScheduledSocket;
    for (let i = 0; i < 3; i++) first.deliver("replies");

    server.refuse(first, CloseCode.TooSlow);
    first.deliver("replies");
    await eventually(() => sockets.length === 2);
    const second = sockets[1] as ScheduledSocket;
    for (let i = 0; i < 3; i++) second.deliver("replies");
    second.drop();
    await eventually(() => sockets.length === 3);
  });

  test("after 4429, reconnects with a growing delay (1 s ×2, at most 30 s)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const server = new ScheduledServer();
    const sockets: ScheduledSocket[] = [];
    void connectDocument({
      url: "scheduled://",
      documentId: "doc",
      key: await generateKey(),
      credentials: as("read"),
      channels: [{ channel: "content", doc: new LoroDoc() }],
      socketFactory: () => {
        const socket = server.connect() as ScheduledSocket;
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 0,
    });
    server.authRefusal = CloseCode.TooManyConnections;
    const refuseLast = () => {
      const socket = sockets.at(-1) as ScheduledSocket;
      socket.deliver("replies"); // open: the client authenticates
      socket.deliver("replies"); // close
    };
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      refuseLast();
      const before = sockets.length;
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    vi.mocked(Math.random).mockRestore();
  });
});

describe("rights (ADR-0019 §1)", () => {
  test("a reader publishes nothing, a reviewer only annotations", async () => {
    const server = new FakeServer();
    const content = { read: new LoroDoc(), suggest: new LoroDoc() };
    const annotations = { read: new LoroDoc(), suggest: new LoroDoc() };
    const connections = [];
    const activities: ActivityCount[] = [];
    for (const role of ["read", "suggest"] as const) {
      const opts = await options(server, role, {
        content: content[role],
        annotations: annotations[role],
      });
      activities.push(opts.activity);
      connections.push(await connectDocument(opts));
      content[role].getText("t").insert(0, role);
      content[role].commit();
      annotations[role].getText("t").insert(0, role);
      annotations[role].commit();
    }
    for (const activity of activities) await activity.settled();

    expect(server.entries("doc-1").map((entry) => entry.channel)).toEqual([
      "annotations",
    ]);
    expect(server.closes).toEqual([]);
    for (const connection of connections) connection.close();
  });

  test("only an editor publishes decisions", async () => {
    const server = new FakeServer();
    const connection = await connectDocument(await options(server, "suggest"));

    expect(() => connection.publishDecision(new Uint8Array([1]))).toThrow();
    connection.close();
  });

  test("a reviewer never compacts", async () => {
    const server = new FakeServer();
    const annotations = new LoroDoc();
    const opts = await options(server, "suggest", { annotations });
    const connection = await connectDocument({
      ...opts,
      compactionThreshold: 1,
    });
    for (let i = 0; i < 3; i++) {
      annotations.getText("t").insert(0, "x");
      annotations.commit();
      await opts.activity.settled();
      expect(server.journaled("doc-1")).toBe(i + 1);
    }

    expect(server.compactRequests).toEqual([]);
    expect(server.closes).toEqual([]);
    connection.close();
  });
});

describe("transport security (ADR-0019 §3)", () => {
  test.each(["ws://example.org/ws", "ws://10.0.0.1:8080/ws"])(
    "refuses %s: the secret would travel in clear",
    async (url) => {
      const server = new FakeServer();
      const opts = await options(server, "read");

      await expect(connectDocument({ ...opts, url })).rejects.toThrow(/TLS/);
      expect(opts.sockets).toBe(0);
    },
  );

  test.each([
    "ws://localhost:8080/ws",
    "ws://127.0.0.1:8080/ws",
    "ws://[::1]:8080/ws",
    "wss://example.org/ws",
  ])("accepts %s", async (url) => {
    const server = new FakeServer();
    const connection = await connectDocument({
      ...(await options(server, "read")),
      url,
    });
    connection.close();
  });
});
