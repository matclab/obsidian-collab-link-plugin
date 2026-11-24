// Readers resist invalid entries (docs/phase-5-modele-acces.md, decision
// 10): a reviewer holds the key and may publish a well-encrypted blob that
// isn't a Loro update; a stolen database allows blobs that don't decrypt.
// Neither may block a join, nor the rest of the session.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { encrypt, generateKey } from "../crypto/aead.js";
import type { ConfirmedRecord } from "./client.js";
import { connectDocument } from "./client.js";
import { encodeAuthMessage, encodeFrame } from "./protocol.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";

const key = await generateKey();

function update(text: string, peer: bigint): Uint8Array {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  doc.getText("t").insert(0, text);
  doc.commit();
  return doc.export({ mode: "update" });
}

const INVALID = {
  "a blob that doesn't decrypt": async () =>
    crypto.getRandomValues(new Uint8Array(40)),
  "a decryptable blob that isn't a Loro update": async () =>
    encrypt(key, new Uint8Array([1, 2, 3, 4])),
};

async function connect(server: FakeServer, doc: LoroDoc) {
  const invalid: string[] = [];
  const confirmed: ConfirmedRecord[] = [];
  const connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: EDITOR,
    channels: [{ channel: "content", doc }],
    decisions: { onConfirmed: (batch) => confirmed.push(...batch) },
    socketFactory: () => server.connect(),
    onInvalidEntry: (channel) => invalid.push(channel),
    reconnectDelayMs: 0,
  });
  return { connection, invalid, confirmed };
}

describe.each(Object.entries(INVALID))("%s", (_, invalidBlob) => {
  test("in a history reply: skipped and reported, the rest imported, the cursor past it", async () => {
    const server = new FakeServer();
    server.append("doc", "content", await encrypt(key, update("a", 1n)));
    server.append("doc", "content", await invalidBlob());
    server.append("doc", "content", await encrypt(key, update("b", 2n)));
    const doc = new LoroDoc();

    const { connection, invalid } = await connect(server, doc);

    expect(doc.getText("t").length).toBe(2);
    expect(invalid).toEqual(["content"]);
    // Reconnecting asks only for what follows the invalid entry.
    const joins = () =>
      server.joinRequests.filter((join) => join.channel === "content");
    const before = joins().length;
    server.disconnectAll();
    await eventually(() => joins().length > before);
    expect(joins().at(-1)).toMatchObject({ since: 3 });
    connection.close();
  });

  test("pushed: skipped and reported, what follows still arrives", async () => {
    const server = new FakeServer();
    const doc = new LoroDoc();
    const { connection, invalid } = await connect(server, doc);
    const raw = server.connect();
    await new Promise<void>((resolve) => {
      raw.onopen = () => resolve();
    });
    raw.send(encodeAuthMessage("doc", "edit", new Uint8Array(32)));
    raw.send(encodeFrame("content", await invalidBlob()));
    raw.send(encodeFrame("content", await encrypt(key, update("c", 3n))));

    await eventually(() => doc.getText("t").toString() === "c");
    expect(invalid).toEqual(["content"]);
    connection.close();
    raw.close();
  });

  test("on the decisions channel: delivered all the same (a record nothing decodes), the prefix stays gapless", async () => {
    const server = new FakeServer();
    server.append("doc", "decisions", await invalidBlob());
    server.append("doc", "decisions", await encrypt(key, new Uint8Array([7])));

    const { connection, confirmed } = await connect(server, new LoroDoc());

    expect(confirmed.map((record) => record.seq)).toEqual([1, 2]);
    expect(confirmed[1]?.record).toEqual(new Uint8Array([7]));
    connection.close();
  });
});
