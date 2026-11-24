// Rotation on the client side (ADR-0019 §5, analysis B): the requester
// comes back with its new edit secret, everyone else is cut for good, and
// a new secret kept before the rotation (R-B4) survives a lost reply or a
// closed tab.
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
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";
import { verifiersSync } from "./test-support/verifiers.js";

const key = await generateKey();

interface Peer {
  doc: LoroDoc;
  connection: DocumentConnection;
  refused: number[];
  renewed: Uint8Array[];
}

async function connect(
  server: FakeServer,
  edit: Uint8Array,
  role: Role,
  pendingEditSecret?: Uint8Array,
): Promise<Peer> {
  const doc = new LoroDoc();
  const refused: number[] = [];
  const renewed: Uint8Array[] = [];
  const connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: { role, secret: (await deriveRoleSecrets(edit))[role] },
    channels: [{ channel: "content", doc }],
    socketFactory: () => server.connect(),
    reconnectDelayMs: 0,
    onRefused: (code) => refused.push(code),
    onRenewed: (secret) => renewed.push(secret),
    ...(pendingEditSecret && { pendingEditSecret }),
  });
  return { doc, connection, refused, renewed };
}

function registered(edit: Uint8Array): FakeServer {
  const server = new FakeServer();
  server.register("doc", verifiersSync(edit));
  return server;
}

async function rotation(next: Uint8Array) {
  return { secret: next, verifiers: await verifiers(next) };
}

describe("rotation (ADR-0019 §5)", () => {
  test("cuts every other link for good; the requester comes back with the new one", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const editor = await connect(server, edit, "edit");
    const reader = await connect(server, edit, "read");
    const next = generateEditSecret();

    await editor.connection.rotate(await rotation(next));
    await eventually(() => editor.renewed.length === 1);

    expect(editor.renewed).toEqual([next]);
    expect(editor.refused).toEqual([]);
    expect(reader.refused).toEqual([CloseCode.Revoked]);
    expect(server.admits("doc", "edit", edit)).toBe(false);
    editor.doc.getText("t").insert(0, "after");
    editor.doc.commit();
    await eventually(() => server.journaled("doc") === 1);
    await expect(connect(server, edit, "read")).rejects.toMatchObject({
      code: CloseCode.Unauthenticated,
    });
    const newReader = await connect(server, next, "read");
    await eventually(() => newReader.doc.getText("t").toString() === "after");
    for (const peer of [editor, newReader]) peer.connection.close();
  });

  test("R-B4: a rotation that passed, the tab closed before its reply — the kept secret opens", async () => {
    const edit = generateEditSecret();
    const next = generateEditSecret();
    const server = registered(next); // rotated, old link now unknown

    const editor = await connect(server, edit, "edit", next);

    expect(editor.renewed).toEqual([next]);
    editor.connection.close();
  });

  test("R-B4: a rotation that never passed — the old link still opens, nothing renewed", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);

    const editor = await connect(server, edit, "edit", generateEditSecret());

    expect(editor.renewed).toEqual([]);
    editor.connection.close();
  });

  test("R-B4: the kept secret is refused too — refused, no loop", async () => {
    const server = registered(generateEditSecret());

    await expect(
      connect(server, generateEditSecret(), "edit", generateEditSecret()),
    ).rejects.toMatchObject({ code: CloseCode.Unauthenticated });
  });

  test("only an editor rotates", async () => {
    const edit = generateEditSecret();
    const server = registered(edit);
    const reviewer = await connect(server, edit, "suggest");

    await expect(
      reviewer.connection.rotate(await rotation(generateEditSecret())),
    ).rejects.toThrow();
    expect(server.closes).toEqual([]);
    reviewer.connection.close();
  });
});
