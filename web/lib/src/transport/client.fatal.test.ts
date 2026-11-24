// A Loro panic poisons the document it hits (docs/phase-9-durcissement.md,
// analysis L4): the client stops for good — nothing sent, no reconnection —
// and says so through `onFatal`, rather than taking it for an unreadable
// entry and going on with a document every later call fails on.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { encrypt, generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { isWasmTrap } from "./fatal.js";
import { encodeAuthMessage, encodeFrame } from "./protocol.js";
import { ActivityCount } from "./test-support/activity-count.js";
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

const TRAP = update("trap", 99n);
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A document whose import of `TRAP` panics, as a hostile update would:
 * a `WebAssembly.RuntimeError`, and every later import too. */
function trappingDoc(): LoroDoc {
  const doc = new LoroDoc();
  let poisoned = false;
  const guard = (updates: Uint8Array[]) => {
    if (poisoned || updates.some((u) => same(u, TRAP))) {
      poisoned = true;
      throw new WebAssembly.RuntimeError("unreachable");
    }
  };
  const importOne = doc.import.bind(doc);
  const importBatch = doc.importBatch.bind(doc);
  doc.import = (bytes) => {
    guard([bytes]);
    return importOne(bytes);
  };
  doc.importBatch = (batch) => {
    guard(batch);
    return importBatch(batch);
  };
  return doc;
}

async function connect(server: FakeServer, doc: LoroDoc) {
  const fatal: unknown[] = [];
  const invalid: string[] = [];
  const activity = new ActivityCount();
  const connection = await connectDocument({
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: EDITOR,
    channels: [{ channel: "content", doc }],
    socketFactory: () => server.connect(),
    onInvalidEntry: (channel) => invalid.push(channel),
    onFatal: (error) => fatal.push(error),
    reconnectDelayMs: 0,
    activity,
  });
  return { connection, fatal, invalid, activity };
}

/** Nothing more goes out: no frame for a local write, no reconnection. */
async function expectStopped(
  server: FakeServer,
  doc: LoroDoc,
  activity: ActivityCount,
): Promise<void> {
  const journaled = server.journaled("doc");
  const joins = server.joinRequests.length;
  server.disconnectAll();
  doc.getText("t").insert(0, "typed after");
  doc.commit();
  await activity.settled();
  expect(server.journaled("doc")).toBe(journaled);
  expect(server.joinRequests.length).toBe(joins);
}

describe("a Loro panic on import (phase 9, L4)", () => {
  test("isWasmTrap tells a panic from an ordinary error", () => {
    expect(isWasmTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isWasmTrap(new Error("Decode error"))).toBe(false);
    expect(isWasmTrap("unreachable")).toBe(false);
  });

  test("in a history reply: reported once, not as an unreadable entry, and the client stops", async () => {
    const server = new FakeServer();
    server.append("doc", "content", await encrypt(key, update("a", 1n)));
    server.append("doc", "content", await encrypt(key, TRAP));
    server.append("doc", "content", await encrypt(key, update("b", 2n)));
    const doc = trappingDoc();

    const { connection, fatal, invalid, activity } = await connect(server, doc);

    await eventually(() => fatal.length > 0);
    expect(fatal).toHaveLength(1);
    expect(isWasmTrap(fatal[0])).toBe(true);
    expect(invalid).toEqual([]);
    await expectStopped(server, doc, activity);
    expect(fatal).toHaveLength(1);
    connection.close();
  });

  test("pushed: reported once, and the client stops", async () => {
    const server = new FakeServer();
    const doc = trappingDoc();
    const { connection, fatal, invalid, activity } = await connect(server, doc);
    const raw = server.connect();
    await new Promise<void>((resolve) => {
      raw.onopen = () => resolve();
    });
    raw.send(encodeAuthMessage("doc", "edit", new Uint8Array(32)));
    raw.send(encodeFrame("content", await encrypt(key, TRAP)));

    await eventually(() => fatal.length > 0);
    expect(fatal).toHaveLength(1);
    expect(invalid).toEqual([]);
    await expectStopped(server, doc, activity);
    connection.close();
    raw.close();
  });
});
