// No message beyond the server's limit (docs/protocol/04-obligations.md,
// O-18): the server cuts such a connection without a 44xx code, and a
// client that sent it again after reconnecting would loop forever. A
// client's own operations that don't fit in one frame leave in several,
// in order, one in flight at a time.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { EDITOR } from "./test-support/credentials.js";
import { eventually } from "./test-support/eventually.js";
import { FakeServer } from "./test-support/fake-server.js";

const key = await generateKey();
const LIMIT = 300;

async function connect(server: FakeServer, maxMessageBytes?: number) {
  const doc = new LoroDoc();
  await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: EDITOR,
    channels: [{ channel: "content", doc }],
    socketFactory: () => server.connect(),
    reconnectDelayMs: 0,
    publishIntervalMs: 0,
    ...(maxMessageBytes !== undefined && { maxMessageBytes }),
  });
  return doc;
}

describe("own operations larger than one message (O-18)", () => {
  test("leave in several frames, each within the limit, and all arrive", async () => {
    const server = new FakeServer();
    server.maxMessageBytes = LIMIT;
    const writer = await connect(server, LIMIT);
    const reader = await connect(server);

    const text = "abcdefghij".repeat(200);
    writer.getText("content").insert(0, text);
    writer.commit();

    await eventually(() => reader.getText("content").toString() === text);
    const entries = server.entries("doc");
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(1 + entry.blob.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(server.closes).toEqual([]);
  });

  test("a burst of commits beyond the limit arrives whole", async () => {
    const server = new FakeServer();
    server.maxMessageBytes = LIMIT;
    const writer = await connect(server, LIMIT);
    const reader = await connect(server);

    for (let i = 0; i < 40; i++) {
      writer.getText("content").insert(0, `line ${i} of the text\n`);
      writer.commit();
    }

    await eventually(
      () =>
        reader.getText("content").toString() ===
        writer.getText("content").toString(),
    );
    expect(server.closes).toEqual([]);
  });
});
