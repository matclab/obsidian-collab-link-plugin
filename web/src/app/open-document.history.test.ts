// @vitest-environment jsdom
//
// What the page writes for the history (phase 7b): nothing on opening,
// the page's peers at its first edit, changes merged by the minute.
import { describe, expect, test } from "vitest";
import { generateKey } from "../../lib/src/crypto/aead.js";
import { peerNames } from "../../lib/src/history/tables.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { EDITOR } from "../../lib/src/transport/test-support/credentials.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { openDocument } from "./open-document.js";

async function open(
  server: FakeServer,
  key: CryptoKey,
  author: string | (() => string),
  activity?: ActivityCount,
) {
  return openDocument({
    ...(activity && { activity }),
    url: "wss://fake/ws",
    documentId: "doc",
    key,
    credentials: EDITOR,
    editorParent: document.createElement("div"),
    panelParent: document.createElement("div"),
    author: typeof author === "string" ? () => author : author,
    socketFactory: () => server.connect(),
  });
}

describe("openDocument, history", () => {
  test("opening journals nothing; the first edit registers the page's peers for everyone", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    const activity = new ActivityCount();
    const writer = await open(server, key, "alice", activity);
    await activity.settled();
    expect(server.journaled("doc")).toBe(0);

    writer.contentDoc.getText("content").insert(0, "hello");
    writer.contentDoc.commit();
    const reader = await open(server, key, "bob");
    await eventually(
      () =>
        peerNames(reader.annotationsDoc).get(writer.contentDoc.peerIdStr) ===
        "alice",
    );
    writer.connection.close();
    reader.connection.close();
  });

  test("changes of a minute's typing merge into one, with a date", async () => {
    const key = await generateKey();
    const opened = await open(new FakeServer(), key, "alice");
    const text = opened.contentDoc.getText("content");
    for (const [i, at] of [0, 20, 50, 130].entries()) {
      opened.contentDoc.setNextCommitTimestamp(1_700_000_000 + at);
      text.insert(i, "x");
      opened.contentDoc.commit();
    }
    const changes = opened.contentDoc
      .getAllChanges()
      .get(opened.contentDoc.peerIdStr);
    expect(changes?.map((change) => change.timestamp - 1_700_000_000)).toEqual([
      0, 130,
    ]);
    opened.connection.close();
  });

  // Phase 7d, decision 9: renamed during the page, every change of the
  // page shows the new name to the others.
  test("a rename rewrites the page's peers, for everyone", async () => {
    const key = await generateKey();
    const server = new FakeServer();
    let name = "alice";
    const writer = await open(server, key, () => name);
    writer.contentDoc.getText("content").insert(0, "hello");
    writer.contentDoc.commit();
    const reader = await open(server, key, "bob");
    const peer = writer.contentDoc.peerIdStr;
    await eventually(
      () => peerNames(reader.annotationsDoc).get(peer) === "alice",
    );

    name = "Alice B.";
    writer.registration.renamed();

    await eventually(
      () => peerNames(reader.annotationsDoc).get(peer) === "Alice B.",
    );
    writer.connection.close();
    reader.connection.close();
  });
});
