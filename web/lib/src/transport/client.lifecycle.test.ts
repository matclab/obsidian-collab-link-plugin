// Deletion and expiry on the client side (ADR-0023, ADR-0024): a deleted
// document closes every connection with 4404, for good; the requester
// whose close was lost gets the 4401 of its reconnection as it is (it
// can't be told from links renewed meanwhile); the expiry comes at each
// authentication and in the reply to the editor who set it.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import {
  type Role,
  deriveRoleSecrets,
  generateEditSecret,
  verifiers,
} from "../crypto/role-secrets.js";
import { type DocumentConnection, connectDocument } from "./client.js";
import { CloseCode } from "./protocol.js";
import { ActivityCount } from "./test-support/activity-count.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";
import { ScheduledServer } from "./test-support/scheduled-server.js";
import { verifiersSync } from "./test-support/verifiers.js";

const key = await generateKey();

interface Peer {
  doc: LoroDoc;
  connection: DocumentConnection;
  refused: number[];
  expiries: (number | null)[];
  activity: ActivityCount;
}

async function connect(
  server: FakeServer,
  edit: Uint8Array,
  role: Role,
): Promise<Peer> {
  const doc = new LoroDoc();
  const refused: number[] = [];
  const expiries: (number | null)[] = [];
  const activity = new ActivityCount();
  const connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: { role, secret: (await deriveRoleSecrets(edit))[role] },
    channels: [{ channel: "content", doc }],
    socketFactory: () => server.connect(),
    reconnectDelayMs: 0,
    onRefused: (code) => refused.push(code),
    onExpiry: (expiresAt) => expiries.push(expiresAt),
    activity,
  });
  return { doc, connection, refused, expiries, activity };
}

function registered(edit: Uint8Array): FakeServer {
  const server = new FakeServer();
  server.register("doc", verifiersSync(edit));
  return server;
}

describe("deletion (ADR-0023 §1)", () => {
  test("closes every connection with 4404, and none reconnects", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    const reader = await connect(server, edit, "read");
    const authentications = server.authentications;

    editor.connection.deleteDocument();
    await eventually(
      () => editor.refused.length === 1 && reader.refused.length === 1,
    );

    expect(editor.refused).toEqual([CloseCode.Deleted]);
    expect(reader.refused).toEqual([CloseCode.Deleted]);
    for (const peer of [editor, reader]) await peer.activity.settled();
    expect(server.authentications).toBe(authentications);
  });

  test("the requester whose close was lost gets its reconnection's 4401 as it is", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    server.dropOnDelete = true;
    const editor = await connect(server, edit, "edit");

    editor.connection.deleteDocument();
    await eventually(() => editor.refused.length === 1);

    expect(server.closes).toEqual([CloseCode.Unauthenticated]);
    expect(editor.refused).toEqual([CloseCode.Unauthenticated]);
  });

  test("after a deletion, nothing more is sent on its connection", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    server.loseDeletes = true;
    const editor = await connect(server, edit, "edit");

    editor.connection.deleteDocument();

    expect(() => editor.connection.deleteDocument()).toThrow();
    await expect(editor.connection.setExpiry(60)).rejects.toThrow();
    const next = generateEditSecret();
    await expect(
      editor.connection.rotate({
        secret: next,
        verifiers: await verifiers(next),
      }),
    ).rejects.toThrow();
    editor.connection.close();
  });

  test("only a connected editor deletes; nothing is sent otherwise", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const reviewer = await connect(server, edit, "suggest");
    const editor = await connect(server, edit, "edit");
    editor.connection.close();

    expect(() => reviewer.connection.deleteDocument()).toThrow();
    expect(() => editor.connection.deleteDocument()).toThrow();
    for (const peer of [reviewer, editor]) await peer.activity.settled();
    expect(server.closes).toEqual([]);
    reviewer.connection.close();
  });
});

describe("expiry (ADR-0023 §2)", () => {
  test("comes at authentication, and from the server's clock in the reply", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");

    expect(editor.expiries).toEqual([null]);
    await expect(editor.connection.setExpiry(3600)).resolves.toBe(
      server.now + 3600,
    );
    expect(editor.expiries).toEqual([null, server.now + 3600]);

    const reader = await connect(server, edit, "read");
    expect(reader.expiries).toEqual([server.now + 3600]);
    await expect(editor.connection.setExpiry(null)).resolves.toBeNull();
    expect(editor.expiries.at(-1)).toBeNull();
    // Not pushed to the others: seen at their next authentication.
    expect(reader.expiries).toEqual([server.now + 3600]);
    for (const peer of [editor, reader]) peer.connection.close();
  });

  test("a publication's ack still goes to its frame around an expiry reply", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    const reader = await connect(server, edit, "read");

    editor.doc.getText("t").insert(0, "before");
    editor.doc.commit();
    const set = editor.connection.setExpiry(60);
    editor.doc.getText("t").insert(6, " after");
    editor.doc.commit();

    await expect(set).resolves.toBe(server.now + 60);
    await eventually(
      () => reader.doc.getText("t").toString() === "before after",
    );
    expect(editor.connection.persisted().channels[0]?.own).toEqual([]);
    for (const peer of [editor, reader]) peer.connection.close();
  });

  test("only a connected editor sets it; a drop before the reply rejects", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const reader = await connect(server, edit, "read");
    const editor = await connect(server, edit, "edit");

    await expect(reader.connection.setExpiry(60)).rejects.toThrow();
    const lost = editor.connection.setExpiry(60);
    server.disconnectAll();
    await expect(lost).rejects.toThrow();
    editor.connection.close();
    await expect(editor.connection.setExpiry(60)).rejects.toThrow();
    expect(server.closes).toEqual([]);
    reader.connection.close();
  });
});

// Found by the controlled-order scenario: between the reply to a rotation
// and the close that follows it, the server has closed the connection
// already. A second rotation sent then would be lost, and replace the kept
// secret (R-B4) by one the server never registered: the valid one lost.
describe("after its rotation's reply, a connection sends nothing more", () => {
  test("no second rotation, no deletion, no expiry", async () => {
    const edit = generateEditSecret();
    const server = new ScheduledServer();
    server.verifiers = verifiersSync(edit);
    const deliverAll = async () => {
      for (let round = 0; round < 50; round++) {
        for (const socket of server.deliverable()) {
          while (socket.replies.length > 0) socket.deliver("replies");
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const opening = connectDocument({
      url: "wss://scheduled/ws",
      documentId: "doc",
      key,
      credentials: { role: "edit", secret: edit },
      channels: [{ channel: "content", doc: new LoroDoc() }],
      socketFactory: () => server.connect(),
      reconnectDelayMs: 0,
    });
    await deliverAll();
    const connection = await opening;
    const next = generateEditSecret();

    const rotating = connection.rotate({
      secret: next,
      verifiers: await verifiers(next),
    });
    server.sockets[0]?.deliver("replies"); // `rotated`, not the close yet
    await rotating;

    expect(() => connection.deleteDocument()).toThrow();
    await expect(connection.setExpiry(60)).rejects.toThrow();
    const again = generateEditSecret();
    await expect(
      connection.rotate({ secret: again, verifiers: await verifiers(again) }),
    ).rejects.toThrow();
    await deliverAll();
    // It came back with the secret of the rotation that passed.
    expect(server.sockets.at(-1)?.role).toBe("edit");
    expect(server.sockets.at(-1)?.dead).toBe(false);
    connection.close();
  });
});
