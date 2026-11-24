// Presence on the transport (ADR-0025): frames relayed, never acked nor
// journaled — the acks of the other frames still go to them (R-P2); a
// reader publishes none; the page is told after each authentication, to
// publish its state again (R-P6).
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import {
  type Role,
  deriveRoleSecrets,
  generateEditSecret,
} from "../crypto/role-secrets.js";
import { type DocumentConnection, connectDocument } from "./client.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";
import { verifiersSync } from "./test-support/verifiers.js";

const key = await generateKey();

interface Peer {
  doc: LoroDoc;
  connection: DocumentConnection;
  received: string[];
  connected: number;
  activity: ActivityCount;
}

async function connect(
  server: FakeServer,
  edit: Uint8Array,
  role: Role,
): Promise<Peer> {
  const doc = new LoroDoc();
  const peer = {
    doc,
    received: [] as string[],
    connected: 0,
    activity: new ActivityCount(),
  } as Peer;
  peer.connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: { role, secret: (await deriveRoleSecrets(edit))[role] },
    channels: [{ channel: "content", doc }],
    socketFactory: () => server.connect(),
    reconnectDelayMs: 0,
    publishIntervalMs: 0,
    activity: peer.activity,
    presence: {
      receive: (state) => peer.received.push(new TextDecoder().decode(state)),
      connected: () => peer.connected++,
    },
  });
  return peer;
}

function registered(edit: Uint8Array): FakeServer {
  const server = new FakeServer();
  server.register("doc", verifiersSync(edit));
  return server;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("presence (ADR-0025)", () => {
  test("reaches the others, decrypted; nothing journaled", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    const reviewer = await connect(server, edit, "suggest");
    const reader = await connect(server, edit, "read");

    reviewer.connection.publishPresence(bytes("bob is here"));

    await eventually(
      () => editor.received.length === 1 && reader.received.length === 1,
    );
    expect(editor.received).toEqual(["bob is here"]);
    expect(reader.received).toEqual(["bob is here"]);
    expect(reviewer.received).toEqual([]);
    expect(server.journaled("doc")).toBe(0);
    for (const peer of [editor, reviewer, reader]) peer.connection.close();
  });

  test("R-P2: interleaved with publications, every ack still goes to its frame", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    const reader = await connect(server, edit, "read");
    const text = editor.doc.getText("t");

    for (const word of ["one ", "two ", "three"]) {
      editor.connection.publishPresence(bytes(`at ${word}`));
      text.insert(text.length, word);
      editor.doc.commit();
      editor.connection.publishPresence(bytes(`after ${word}`));
    }

    await eventually(
      () => reader.doc.getText("t").toString() === "one two three",
    );
    await eventually(() => reader.received.length === 6);
    await eventually(
      () => editor.connection.persisted().channels[0]?.own.length === 0,
    );
    // Only the text's frames were journaled, and each got its own ack.
    expect(
      server.entries("doc").every((entry) => entry.channel === "content"),
    ).toBe(true);
    for (const peer of [editor, reader]) peer.connection.close();
  });

  test("a reader publishes nothing, and nothing leaves while disconnected", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const reader = await connect(server, edit, "read");
    const editor = await connect(server, edit, "edit");

    reader.connection.publishPresence(bytes("reader"));
    editor.connection.close();
    editor.connection.publishPresence(bytes("closed"));

    for (const peer of [reader, editor]) await peer.activity.settled();
    expect(server.presenceFrames).toBe(0);
    expect(server.closes).toEqual([]);
    reader.connection.close();
  });

  test("R-P6: told after each authentication, to publish again", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    expect(editor.connected).toBe(1);

    server.disconnectAll();

    await eventually(() => editor.connected === 2);
    editor.connection.close();
  });
});
