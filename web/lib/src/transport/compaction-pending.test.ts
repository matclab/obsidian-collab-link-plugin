// R-A3 (docs/phase-5-modele-acces.md, step 2, analysis A): a compaction
// taken while an operation is pending — imported, but waiting for a
// dependency the client doesn't have — leaves it out of the snapshot, and
// the journal entry that carried it is gone: lost for everyone. It happens
// when an editor types right after a change it adopted (ADR-0018) and its
// typing is journaled before the change. The client defers such a
// compaction, and only overrides after a few attempts (a writer whose
// dependencies never come must not block compaction for good).
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { decrypt, generateKey } from "../crypto/aead.js";
import { connectDocument } from "./client.js";
import { importHistory } from "./import-history.js";
import { EDITOR } from "./test-support/credentials.js";
import {
  ScheduledServer,
  type ScheduledSocket,
} from "./test-support/scheduled-server.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Work the clients have in progress (timers, encryption): delivering is
// done once nothing is left to deliver while none is at work.
let busy = 0;
const activity = { begin: () => busy++, end: () => busy-- };

async function deliverAll(server: ScheduledServer): Promise<void> {
  for (let quiet = 0; quiet < 2; ) {
    const sockets = server.deliverable();
    for (const socket of sockets) {
      while (socket.replies.length > 0) socket.deliver("replies");
      while (socket.pushes.length > 0) socket.deliver("pushes");
    }
    await tick();
    quiet = sockets.length === 0 && busy === 0 ? quiet + 1 : 0;
  }
}

async function setUp(options: { adopt?: boolean } = {}) {
  const key = await generateKey();
  const server = new ScheduledServer();
  const connect = (doc: LoroDoc, compactionThreshold: number) =>
    connectDocument({
      url: "scheduled://",
      documentId: "doc",
      key,
      credentials: EDITOR,
      channels: [{ channel: "content", doc }],
      socketFactory: () => server.connect() as ScheduledSocket,
      compactionThreshold,
      publishIntervalMs: 0,
      reconnectDelayMs: 0,
      activity,
    });
  const editor = new LoroDoc();
  const compactor = new LoroDoc();
  const editorConnection = connect(editor, 1_000_000);
  void connect(compactor, 3);
  editor.getText("t").insert(0, "hello world");
  editor.commit();
  await deliverAll(server);

  // X: a detached change the editor adopts (imported, never published by
  // it: not its own operations); Y: typed right after it, so it depends
  // on X, and published.
  const fork = editor.fork();
  fork.setPeerId(77n);
  const before = fork.oplogVersion();
  fork.getText("t").insert(5, " dear");
  fork.commit();
  const x = fork.export({ mode: "update", from: before });
  editor.import(x);
  if (options.adopt) (await editorConnection).adopt("content", x);
  editor.getText("t").insert(10, "est");
  editor.commit();
  await deliverAll(server);
  if (!options.adopt) {
    expect(compactor.getText("t").toString()).toBe("hello world"); // Y pending
  }

  /** The compactor types enough to cross its threshold. */
  const crossThreshold = async () => {
    compactor.getText("t").insert(compactor.getText("t").length, "ccc");
    compactor.commit();
    await deliverAll(server);
  };
  /** What a newcomer reads from the journal, given X too unless said. */
  const newcomerText = async (givenX = true) => {
    const updates: Uint8Array[] = [];
    for (const entry of server.journal) {
      updates.push(await decrypt(key, entry.blob));
    }
    const newcomer = new LoroDoc();
    importHistory(newcomer, givenX ? [...updates, x] : updates);
    return newcomer.getText("t").toString();
  };
  const compacted = () =>
    server.journal.length > 0 &&
    server.journal.every((entry) => entry.seq !== 1);
  return { compactor, server, x, crossThreshold, newcomerText, compacted };
}

describe("compaction with pending operations (R-A3)", () => {
  test("a compaction is deferred while an operation is pending: nothing is lost", async () => {
    const { crossThreshold, newcomerText, compacted } = await setUp();

    await crossThreshold();

    expect(await newcomerText()).toContain("hello dearest world");
    expect(compacted()).toBe(false);
  });

  test("once the dependency arrives, the next crossing compacts, the operation included", async () => {
    const { compactor, x, crossThreshold, newcomerText, compacted } =
      await setUp();
    await crossThreshold();

    compactor.import(x); // applying the acceptance itself
    await crossThreshold();

    expect(compacted()).toBe(true);
    expect(await newcomerText()).toContain("hello dearest world");
  });

  test("an operation still pending after a few attempts no longer blocks compaction", async () => {
    const { crossThreshold, compacted } = await setUp();

    await crossThreshold();
    await crossThreshold();
    expect(compacted()).toBe(false);
    await crossThreshold();

    expect(compacted()).toBe(true);
  });
});

describe("an adopted change is published before what depends on it (R-A1)", () => {
  test("the change is journaled before the typing: nothing pending, nothing lost", async () => {
    const { compactor, crossThreshold, newcomerText, compacted } = await setUp({
      adopt: true,
    });

    expect(compactor.getText("t").toString()).toBe("hello dearest world");
    await crossThreshold();

    expect(compacted()).toBe(true); // first crossing: nothing was pending
    expect(await newcomerText(false)).toContain("hello dearest world");
  });
});
