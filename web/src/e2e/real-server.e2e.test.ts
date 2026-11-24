// @vitest-environment jsdom
//
// End-to-end check required by docs/phase-1-squelette-vertical.md step 7:
// two client instances against a REAL server process (the compiled
// server/target/debug/server binary, not a fake in-memory one) doing real
// concurrent editing through real CodeMirror EditorView instances (jsdom,
// since a real browser is unavailable in this sandbox — the chat reported
// the Playwright limitation, plus the manual browser verification steps for
// whoever runs this outside the sandbox).
//
// Excluded from `npm test` (see vitest.config.ts): it spawns an OS process
// and binds a real port, so it doesn't belong in the fast/hermetic unit
// suite gated by AGENTS.md §5. Run explicitly with `npm run test:e2e`.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoroDoc, LoroMap } from "loro-crdt";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AnnotationIndex,
  type AnnotationType,
  DecisionLog,
  LocalDecisions,
  checkDetachedChange,
  computeAnnotationsView,
  createAnnotation,
  listAnnotations,
  resolveAnnotation,
  suggestAddition,
  tryCreateAnnotation,
  watchDecisionEffects,
} from "../../lib/src/annotations/index.js";
import { decrypt, encrypt, generateKey } from "../../lib/src/crypto/aead.js";
import {
  type Role,
  deriveRoleSecrets,
  generateEditSecret,
  verifiers,
} from "../../lib/src/crypto/role-secrets.js";
import { peerNames } from "../../lib/src/history/tables.js";
import {
  createDocument as createRegisteredDocument,
  documentLinks,
} from "../../lib/src/links/links.js";
import { renewLinks } from "../../lib/src/links/renew-links.js";
import { openLink } from "../../lib/src/open-link.js";
import { hostileCursorBytes } from "../../lib/src/test-support/hostile-cursor.js";
import {
  type SocketFactory,
  connectDocument,
} from "../../lib/src/transport/index.js";
import {
  type ChannelName,
  decodeHistoryReply,
  encodeAuthMessage,
  encodeFrame,
  encodeJoinMessage,
} from "../../lib/src/transport/protocol.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { openDocument } from "../app/open-document.js";
import { exportMarkdown, importMarkdown } from "../criticmarkup/index.js";
import { extractNotes } from "../criticmarkup/notes.js";
import { createDocumentEditor } from "../editor/editor.js";
import { textAt } from "../history/index.js";
import { HistoryModel } from "../ui/history/history-model.js";
import {
  createTrackedNodeWebSocketFactory,
  nodeWebSocketFactory,
} from "./node-websocket.js";

const PORT = 18080;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const serverBinary = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../server/target/debug/server",
);

let serverProcess: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${BASE_URL}/documents`, { method: "POST" });
      return; // listening: any answer will do
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("real server did not start in time");
}

function containsSubsequence(
  haystack: Uint8Array,
  needle: Uint8Array,
): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** The edit secret of every document created here, to connect as an
 * editor (ADR-0019). */
const editSecrets = new Map<string, Uint8Array>();

async function createDocument(): Promise<string> {
  const { documentId, editSecret } = await createRegisteredDocument(BASE_URL);
  editSecrets.set(documentId, editSecret);
  return documentId;
}

/** Credentials of `role` for a document created by `createDocument`. */
async function as(documentId: string, role: Role = "edit") {
  const edit = editSecrets.get(documentId);
  if (!edit) throw new Error(`unknown document ${documentId}`);
  return { role, secret: (await deriveRoleSecrets(edit))[role] };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Joins raw (bypassing `connectDocument`) with an explicit `since` and
 * returns the decoded history reply — used to inspect exactly what the
 * real server sends back for a given cursor, per
 * docs/phase-2-persistance-reprise.md's exit criterion that the resume
 * payload's *content* is checked, not just eventual convergence. */
async function joinRawAndGetHistory(
  documentId: string,
  channel: ChannelName = "content",
  since?: number,
) {
  // The secret first: derived asynchronously, it would otherwise race
  // the socket's opening, and an `onopen` set after it never fires.
  const { role, secret } = await as(documentId, "read");
  const socket = nodeWebSocketFactory(WS_URL);
  const reply = await new Promise<string>((resolve) => {
    socket.onopen = () => {
      socket.send(encodeAuthMessage(documentId, role, secret));
      socket.send(encodeJoinMessage(documentId, channel, since));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string" && event.data.includes("history")) {
        resolve(event.data);
      }
    };
  });
  socket.close();
  return decodeHistoryReply(reply);
}

/** A full client as main.ts wires it, minus the DOM: both Loro channels,
 * the decisions channel, and effects applied from the confirmed log. */
async function decidingClient(
  documentId: string,
  key: CryptoKey,
  author: string,
  options: { socketFactory?: SocketFactory; compactionThreshold?: number } = {},
) {
  const content = new LoroDoc();
  const annotations = new LoroDoc();
  const log = new DecisionLog();
  const stopEffects = watchDecisionEffects(
    new AnnotationIndex(content, annotations, log),
    log,
  );
  const connection = await connectDocument({
    url: WS_URL,
    documentId,
    key,
    credentials: await as(documentId),
    channels: [
      { channel: "content", doc: content },
      { channel: "annotations", doc: annotations },
    ],
    decisions: { onConfirmed: (batch) => log.add(batch) },
    socketFactory: options.socketFactory ?? nodeWebSocketFactory,
    ...(options.compactionThreshold !== undefined && {
      compactionThreshold: options.compactionThreshold,
    }),
  });
  const decisions = new LocalDecisions(log, (record) =>
    connection.publishDecision(record),
  );
  return {
    content,
    annotations,
    decisions,
    text: () => content.getText("content").toString(),
    status: (id: string) =>
      listAnnotations(content, annotations).find((a) => a.id === id)?.status,
    /** An annotation's detached change, as the panel copies it on accept. */
    change: (id: string) => resolveAnnotation(content, annotations, id)?.change,
    close: () => {
      stopEffects();
      connection.close();
    },
  };
}

beforeAll(async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), "obsidian-collab-e2e-"));
  serverProcess = spawn(serverBinary, [], {
    env: {
      ...process.env,
      BIND_ADDR: `127.0.0.1:${PORT}`,
      DATABASE_PATH: path.join(dbDir, "journal.sqlite3"),
    },
  });
  await waitForServer();
});

afterAll(() => {
  serverProcess.kill();
});

describe("real server + real client modules, no simulation", () => {
  test("two real editors converge through the real relay, and the server only ever relays ciphertext", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const seenFrames: Uint8Array[] = [];
    const sniffer = nodeWebSocketFactory(WS_URL);
    await new Promise<void>((resolve) => {
      sniffer.onopen = () => resolve();
    });
    sniffer.onmessage = (event) => {
      if (typeof event.data !== "string")
        seenFrames.push(new Uint8Array(event.data));
    };
    const reader = await as(documentId, "read");
    sniffer.send(encodeAuthMessage(documentId, reader.role, reader.secret));
    sniffer.send(JSON.stringify({ join: documentId, channel: "content" }));

    const docA = new LoroDoc();
    const docB = new LoroDoc();
    const editorA = createDocumentEditor(document.createElement("div"), docA);
    const editorB = createDocumentEditor(document.createElement("div"), docB);

    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docA }],
      socketFactory: nodeWebSocketFactory,
    });
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docB }],
      socketFactory: nodeWebSocketFactory,
    });

    editorA.view.dispatch({ changes: { from: 0, insert: "hello from A " } });
    editorB.view.dispatch({ changes: { from: 0, insert: "hi from B " } });

    await wait(500);

    const textA = editorA.view.state.doc.toString();
    const textB = editorB.view.state.doc.toString();
    expect(textA).toBe(textB);
    expect(textA).toContain("hello from A");
    expect(textA).toContain("hi from B");

    expect(seenFrames.length).toBeGreaterThan(0);
    const plaintextBytes = new TextEncoder().encode("hello from A");
    for (const frame of seenFrames) {
      expect(containsSubsequence(frame, plaintextBytes)).toBe(false);
    }

    connectionA.close();
    connectionB.close();
    sniffer.close();
  }, 20000);

  test("offline scenario: a client edits while disconnected, then catches up on reconnect", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const docA = new LoroDoc();
    const editorA = createDocumentEditor(document.createElement("div"), docA);
    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docA }],
      socketFactory: nodeWebSocketFactory,
    });

    editorA.view.dispatch({
      changes: { from: 0, insert: "written before going offline" },
    });
    await wait(200);

    connectionA.close();

    editorA.view.dispatch({
      changes: { from: editorA.view.state.doc.length, insert: " and after" },
    });

    const docB = new LoroDoc();
    createDocumentEditor(document.createElement("div"), docB);
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docB }],
      socketFactory: nodeWebSocketFactory,
    });
    await wait(200);

    expect(docB.getText("content").toString()).toBe(
      "written before going offline",
    );

    const reconnectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docA }],
      socketFactory: nodeWebSocketFactory,
    });
    await wait(300);

    expect(docB.getText("content").toString()).toContain("and after");

    reconnectionA.close();
    connectionB.close();
  }, 20000);

  test("a real, ungraceful disconnect: the client's own reconnect timer resumes with a cursor, converging while both peers edited concurrently", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const { factory: trackedFactory, killLast } =
      createTrackedNodeWebSocketFactory();

    const docA = new LoroDoc();
    const editorA = createDocumentEditor(document.createElement("div"), docA);
    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docA }],
      socketFactory: trackedFactory,
    });

    editorA.view.dispatch({ changes: { from: 0, insert: "before drop" } });
    await wait(300); // let the publish land and get acked

    const cursorBeforeDrop = (await joinRawAndGetHistory(documentId))[0]?.seq;
    expect(cursorBeforeDrop).toBeDefined();

    const docB = new LoroDoc();
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docB }],
      socketFactory: nodeWebSocketFactory,
    });
    await wait(200);

    // A real network drop — no close frame — so it's connectDocument's own
    // internal reconnect timer that has to fire, not a fresh call standing
    // in for one.
    killLast();

    // Both peers edit concurrently while A is down, exercising the same
    // divergent-branches-merge scenario as choice/loro/t3, now over a real
    // reconnecting network client instead of an in-memory simulation.
    editorA.view.dispatch({
      changes: {
        from: editorA.view.state.doc.length,
        insert: " from A while down",
      },
    });
    docB
      .getText("content")
      .insert(docB.getText("content").length, " from B while A is down");
    docB.commit();

    await wait(1200); // past the reconnect delay + propagation

    const textA = docA.getText("content").toString();
    const textB = docB.getText("content").toString();
    expect(textA).toBe(textB);
    expect(textA).toContain("before drop");
    expect(textA).toContain("from A while down");
    expect(textA).toContain("from B while A is down");

    // The resume protocol's own contract, checked on the actual response
    // content (not just the fact that things converged): a join with the
    // pre-drop cursor must only return what followed it.
    const resumedHistory = await joinRawAndGetHistory(
      documentId,
      "content",
      cursorBeforeDrop,
    );
    expect(
      resumedHistory.every((entry) => entry.seq > (cursorBeforeDrop as number)),
    ).toBe(true);
    expect(resumedHistory.length).toBeGreaterThan(0);

    connectionA.close();
    connectionB.close();
  }, 20000);

  test("a real client's automatic compaction shrinks the server's stored journal", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const doc = new LoroDoc();
    const connection = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc }],
      socketFactory: nodeWebSocketFactory,
      compactionThreshold: 5,
    });

    const text = doc.getText("content");
    for (let i = 0; i < 5; i++) {
      text.insert(text.length, "x");
      doc.commit();
      await wait(50);
    }
    await wait(300); // let the compaction request land and be applied

    const historyAfterCompaction = await joinRawAndGetHistory(documentId);
    expect(historyAfterCompaction).toHaveLength(1); // squashed into one snapshot entry
    expect(historyAfterCompaction[0]?.blob.length).toBeGreaterThan(0);

    connection.close();
  }, 20000);

  test("two channels converge independently through the real server", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const contentA = new LoroDoc();
    const annotationsA = new LoroDoc();
    const contentB = new LoroDoc();
    const annotationsB = new LoroDoc();

    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [
        { channel: "content", doc: contentA },
        { channel: "annotations", doc: annotationsA },
      ],
      socketFactory: nodeWebSocketFactory,
    });
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [
        { channel: "content", doc: contentB },
        { channel: "annotations", doc: annotationsB },
      ],
      socketFactory: nodeWebSocketFactory,
    });

    contentA.getText("content").insert(0, "content from A");
    contentA.commit();
    annotationsA.getText("content").insert(0, "annotation from A");
    annotationsA.commit();
    await wait(300); // let A's edits land on B first, so B's edit below isn't concurrent (its exact merge position is this test's business to check, not CRDT tie-breaking)

    contentB
      .getText("content")
      .insert(contentB.getText("content").length, " and content from B");
    contentB.commit();

    await wait(500);

    expect(contentB.getText("content").toString()).toBe(
      "content from A and content from B",
    );
    expect(annotationsB.getText("content").toString()).toBe(
      "annotation from A",
    );
    expect(contentA.getText("content").toString()).toBe(
      contentB.getText("content").toString(),
    );
    expect(annotationsA.getText("content").toString()).toBe(
      annotationsB.getText("content").toString(),
    );

    connectionA.close();
    connectionB.close();
  }, 20000);

  test("exit criterion: publishing on annotations leaves content's version untouched through the real server, and vice versa", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const contentA = new LoroDoc();
    const annotationsA = new LoroDoc();
    const contentB = new LoroDoc();
    const annotationsB = new LoroDoc();

    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [
        { channel: "content", doc: contentA },
        { channel: "annotations", doc: annotationsA },
      ],
      socketFactory: nodeWebSocketFactory,
    });
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [
        { channel: "content", doc: contentB },
        { channel: "annotations", doc: annotationsB },
      ],
      socketFactory: nodeWebSocketFactory,
    });
    await wait(200);

    // A version vector comparison, not just "the displayed text is
    // unchanged" — that would miss a no-op edit landing on the wrong doc.
    const contentVersionBefore = contentB.oplogVersion();
    annotationsA.getText("content").insert(0, "an annotation");
    annotationsA.commit();
    await wait(300);
    expect(annotationsB.getText("content").toString()).toBe("an annotation");
    expect(contentB.oplogVersion().compare(contentVersionBefore)).toBe(0);

    const annotationsVersionBefore = annotationsB.oplogVersion();
    contentA.getText("content").insert(0, "some content");
    contentA.commit();
    await wait(300);
    expect(contentB.getText("content").toString()).toBe("some content");
    expect(annotationsB.oplogVersion().compare(annotationsVersionBefore)).toBe(
      0,
    );

    connectionA.close();
    connectionB.close();
  }, 20000);

  test("ADR-0011: a peer that reconnects behind and immediately compacts loses no concurrent op", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const { factory: trackedFactory, killLast } =
      createTrackedNodeWebSocketFactory();

    const docA = new LoroDoc();
    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docA }],
      socketFactory: trackedFactory,
      compactionThreshold: 1,
    });
    docA.getText("content").insert(0, "before drop");
    docA.commit();
    await wait(300);

    const docB = new LoroDoc();
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [{ channel: "content", doc: docB }],
      socketFactory: nodeWebSocketFactory,
    });
    await wait(200);

    // A real, ungraceful drop — A falls behind while down.
    killLast();

    docB
      .getText("content")
      .insert(docB.getText("content").length, " from B while A is down");
    docB.commit();
    await wait(200);

    // A's own reconnect timer fires, resumes with its cursor, and (with
    // compactionThreshold 1) immediately tries to compact right after —
    // concurrently with having just caught up on B's op.
    await wait(1200); // past the reconnect delay + propagation + compaction

    docA
      .getText("content")
      .insert(docA.getText("content").length, " and more from A");
    docA.commit();
    await wait(500);

    // Nothing lost: a brand new peer joining fresh must see every op that
    // was ever made, regardless of the compaction(s) that happened along
    // the way and the exact order messages actually arrived in.
    const finalHistory = await joinRawAndGetHistory(documentId);
    expect(finalHistory.length).toBeGreaterThan(0);

    const docCheck = new LoroDoc();
    for (const entry of finalHistory) {
      docCheck.import(await decrypt(key, entry.blob));
    }
    const finalText = docCheck.getText("content").toString();
    expect(finalText).toContain("before drop");
    expect(finalText).toContain("from B while A is down");
    expect(finalText).toContain("and more from A");

    connectionA.close();
    connectionB.close();
  }, 20000);

  test("ADR-0017: a peer offline while another compacts comes back, publishes, and a newcomer sees everything", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const editor = await as(documentId);
    const connect = (doc: LoroDoc, compactionThreshold?: number) =>
      connectDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: editor,
        channels: [{ channel: "content", doc }],
        socketFactory: nodeWebSocketFactory,
        ...(compactionThreshold !== undefined && { compactionThreshold }),
      });

    const docA = new LoroDoc();
    const connectionA = await connect(docA, 3);
    const docB = new LoroDoc();
    const connectionB = await connect(docB);
    docA.getText("content").insert(0, "shared ");
    docA.commit();
    await wait(300);
    expect(docB.getText("content").toString()).toBe("shared ");

    // B writes offline, on a state A goes on to compact past.
    connectionB.close();
    docB.getText("content").insert(0, "B offline, ");
    docB.commit();
    for (const letter of "xyz") {
      const text = docA.getText("content");
      text.insert(text.length, letter);
      docA.commit();
      await wait(100);
    }
    await wait(300); // let the compaction land
    const compacted = await joinRawAndGetHistory(documentId);
    expect(compacted).toHaveLength(1);
    expect(
      (await decrypt(key, compacted[0]?.blob ?? new Uint8Array())).length,
    ).toBeGreaterThan(0);

    const reconnectionB = await connect(docB); // B comes back and publishes
    await wait(300);
    expect(docA.getText("content").toString()).toContain("B offline, ");

    // Raced: before ADR-0017 the newcomer's join never completed.
    const newcomer = new LoroDoc();
    const connectionNew = await Promise.race([
      connect(newcomer),
      wait(2000).then(() => undefined),
    ]);
    await wait(300);
    expect(newcomer.getText("content").toString()).toBe(
      docA.getText("content").toString(),
    );
    expect(newcomer.getText("content").toString()).toContain("B offline, ");
    expect(newcomer.getText("content").toString()).toContain("xyz");

    connectionNew?.close();
    reconnectionB.close();
    connectionA.close();
  }, 20000);

  test("phase 4bis: one peer creates a suggestion, the other accepts it, content and status converge on both", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const a = await decidingClient(documentId, key, "alice");
    a.content.getText("content").insert(0, "hello world");
    a.content.commit();
    const b = await decidingClient(documentId, key, "bob");
    await wait(300);

    const id = createAnnotation(a.content, a.annotations, {
      type: "deletion",
      start: 0,
      end: 6, // "hello "
      author: "alice",
    });
    await wait(400);
    expect(b.status(id)).toBe("open");

    b.decisions.propose(id, "accept", "bob");
    expect(b.decisions.outcome(id)).toEqual({
      kind: "pending",
      decision: "accept",
    });
    await wait(600);

    expect(a.text()).toBe("world");
    expect(b.text()).toBe("world");
    expect(a.status(id)).toBe("accepted");
    expect(b.status(id)).toBe("accepted");
    expect(b.decisions.outcome(id)).toEqual({ kind: "won" });

    a.close();
    b.close();
  }, 20000);

  // ADR-0013's table, through the real server: before, a substitution
  // accepted twice gave "byebye world", and a deletion accepted by one and
  // rejected by the other lost its text under a "rejected" status.
  test("phase 4bis: concurrent decisions on the same suggestions — the first journaled wins, text and status agree everywhere", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const a = await decidingClient(documentId, key, "alice");
    a.content.getText("content").insert(0, "hello world");
    a.content.commit();
    const b = await decidingClient(documentId, key, "bob");
    await wait(300);

    const substitution = tryCreateAnnotation(a.content, a.annotations, {
      type: "substitution",
      start: 0,
      end: 5,
      author: "alice",
      replacement: "bye",
    });
    const deletion = tryCreateAnnotation(a.content, a.annotations, {
      type: "deletion",
      start: 6,
      end: 11, // "world"
      author: "alice",
    });
    if (!substitution.ok || !deletion.ok) throw new Error("unexpected refusal");
    await wait(400);
    // ADR-0018: the replacement is a detached change, not in content.
    expect(b.text()).toBe("hello world");

    // Both decide both, without waiting for each other; an acceptance
    // carries the change, as the panel copies it.
    a.decisions.propose(
      substitution.id,
      "accept",
      "alice",
      a.change(substitution.id),
    );
    b.decisions.propose(
      substitution.id,
      "accept",
      "bob",
      b.change(substitution.id),
    );
    a.decisions.propose(deletion.id, "accept", "alice");
    b.decisions.propose(deletion.id, "reject", "bob");
    await wait(800);

    expect(a.text()).toBe(b.text());
    expect(a.status(substitution.id)).toBe("accepted");
    expect(b.status(substitution.id)).toBe("accepted");
    expect(a.text().startsWith("bye ")).toBe(true); // replaced once
    const deletionStatus = a.status(deletion.id);
    expect(b.status(deletion.id)).toBe(deletionStatus);
    expect(a.text()).toBe(deletionStatus === "accepted" ? "bye " : "bye world");
    // exactly one of the two deletion proposals won, the other says so
    const outcomes = [
      a.decisions.outcome(deletion.id)?.kind,
      b.decisions.outcome(deletion.id)?.kind,
    ].sort();
    expect(outcomes).toEqual(["lost", "won"]);

    a.close();
    b.close();
  }, 20000);

  test("phase 4bis: a decision taken offline is sent on reconnect and loses to one journaled meanwhile", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const { factory, killLast } = createTrackedNodeWebSocketFactory();
    const a = await decidingClient(documentId, key, "alice");
    a.content.getText("content").insert(0, "hello world");
    a.content.commit();
    const b = await decidingClient(documentId, key, "bob", {
      socketFactory: factory,
    });
    await wait(300);
    const id = createAnnotation(a.content, a.annotations, {
      type: "deletion",
      start: 6,
      end: 11,
      author: "alice",
    });
    await wait(400);

    killLast(); // B drops, no close handshake
    await wait(50);
    b.decisions.propose(id, "accept", "bob"); // offline
    a.decisions.propose(id, "reject", "alice");
    await wait(1500); // past B's reconnect delay

    expect(a.status(id)).toBe("rejected");
    expect(b.status(id)).toBe("rejected");
    expect(a.text()).toBe("hello world");
    expect(b.text()).toBe("hello world");
    expect(b.decisions.outcome(id)).toMatchObject({
      kind: "lost",
      winner: { author: "alice", decision: "reject" },
    });

    a.close();
    b.close();
  }, 20000);

  test("phase 4bis: after compacting content and annotations, a new client derives the same statuses and text", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const a = await decidingClient(documentId, key, "alice", {
      compactionThreshold: 3,
    });
    a.content.getText("content").insert(0, "hello world");
    a.content.commit();
    await wait(200);
    const accepted = createAnnotation(a.content, a.annotations, {
      type: "deletion",
      start: 0,
      end: 6,
      author: "alice",
    });
    const added = suggestAddition(a.content, a.annotations, {
      at: 11,
      text: "?",
      author: "alice",
    });
    await wait(200);
    a.decisions.propose(accepted, "accept", "alice");
    a.decisions.propose(added, "accept", "alice", a.change(added));
    await wait(600);
    expect(a.text()).toBe("world?");
    // enough ops on both Loro channels to cross the threshold
    for (let i = 0; i < 4; i++) {
      a.content
        .getText("content")
        .insert(a.content.getText("content").length, "!");
      a.content.commit();
      createAnnotation(a.content, a.annotations, {
        type: "comment",
        start: 0,
        end: 1,
        author: "alice",
        body: `c${i}`,
      });
      await wait(80);
    }
    await wait(500);
    expect(
      (await joinRawAndGetHistory(documentId, "content")).length,
    ).toBeLessThan(5);
    expect(
      (await joinRawAndGetHistory(documentId, "annotations")).length,
    ).toBeLessThan(7);

    const late = await decidingClient(documentId, key, "carol");
    await wait(500);

    expect(late.text()).toBe(a.text());
    expect(late.status(accepted)).toBe("accepted");
    expect(late.status(added)).toBe("accepted");
    expect(late.status(accepted)).toBe(a.status(accepted));

    a.close();
    late.close();
  }, 20000);

  test("phase 6: export to CriticMarkup, import into a new document, and a new client recovers the same text and annotations", async () => {
    const key = await generateKey();
    const documentId = await createDocument();

    const contentA = new LoroDoc();
    const annotationsA = new LoroDoc();
    contentA.getText("content").insert(0, "hello world");
    contentA.commit();

    const connectionA = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId),
      channels: [
        { channel: "content", doc: contentA },
        { channel: "annotations", doc: annotationsA },
      ],
      socketFactory: nodeWebSocketFactory,
    });

    suggestAddition(contentA, annotationsA, {
      at: 11,
      text: "!!",
      author: "alice",
    });
    createAnnotation(contentA, annotationsA, {
      type: "comment",
      start: 0,
      end: 5, // "hello"
      author: "bob",
      body: "greeting",
    });
    await wait(300);

    const originalText = contentA.getText("content").toString();
    const exported = exportMarkdown(
      originalText,
      computeAnnotationsView(contentA, annotationsA),
    );
    expect(exported).toMatchObject({
      kind: "exported",
      omitted: 0,
      ambiguous: false,
      pointed: 0,
    });
    if (exported.kind !== "exported") return;
    // The marks and references, then a note each: who, when, what (ADR-0034).
    const written = extractNotes(exported.markdown);
    expect(written.body).toBe("{==hello==}[^cm-1] world{++!!++}[^sg-1]");
    expect(written.notes.get("cm-1")).toMatchObject([
      { author: "bob", text: "greeting" },
    ]);
    expect(written.notes.get("sg-1")).toMatchObject([
      { author: "alice", text: "" },
    ]);

    // Imported by an editor into a new, empty document, through the real
    // server (phase 6 decision 8)...
    const importedId = await createDocument();
    const contentB = new LoroDoc();
    const annotationsB = new LoroDoc();
    const connectionB = await connectDocument({
      url: WS_URL,
      documentId: importedId,
      key,
      credentials: await as(importedId),
      channels: [
        { channel: "content", doc: contentB },
        { channel: "annotations", doc: annotationsB },
      ],
      socketFactory: nodeWebSocketFactory,
    });
    expect(
      importMarkdown(exported.markdown, contentB, annotationsB, "carol"),
    ).toEqual([]);

    // ...then opened by a client that never saw either document: same
    // text, same annotations, the same file once exported again.
    const contentC = new LoroDoc();
    const annotationsC = new LoroDoc();
    const connectionC = await connectDocument({
      url: WS_URL,
      documentId: importedId,
      key,
      credentials: await as(importedId, "read"),
      channels: [
        { channel: "content", doc: contentC },
        { channel: "annotations", doc: annotationsC },
      ],
      socketFactory: nodeWebSocketFactory,
    });
    const exportedAgain = () =>
      exportMarkdown(
        contentC.getText("content").toString(),
        computeAnnotationsView(contentC, annotationsC),
      );
    await eventually(
      () => JSON.stringify(exportedAgain()) === JSON.stringify(exported),
    );
    expect(contentC.getText("content").toString()).toBe(originalText);
    // Their authors come back with them, from the notes (ADR-0034): no
    // longer the importer's.
    expect(
      listAnnotations(contentC, annotationsC).map((a) => [a.type, a.author]),
    ).toEqual(
      expect.arrayContaining([
        ["addition", "alice"],
        ["comment", "bob"],
      ]),
    );

    connectionB.close();
    connectionC.close();
    connectionA.close();
  }, 20000);

  test("ADR-0019 §5: a rotation cuts the other links for good, the requester comes back with its new one", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const contentEditor = new LoroDoc();
    const contentReader = new LoroDoc();
    const refused: number[] = [];
    const renewed: Uint8Array[] = [];
    const editor = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "edit"),
      channels: [{ channel: "content", doc: contentEditor }],
      socketFactory: nodeWebSocketFactory,
      reconnectDelayMs: 0,
      onRenewed: (secret) => renewed.push(secret),
    });
    const reader = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "read"),
      channels: [{ channel: "content", doc: contentReader }],
      socketFactory: nodeWebSocketFactory,
      onRefused: (code) => refused.push(code),
    });

    const next = generateEditSecret();
    await editor.rotate({ secret: next, verifiers: await verifiers(next) });
    await eventually(() => renewed.length === 1 && refused.length === 1);
    expect(renewed).toEqual([next]);
    expect(refused).toEqual([4410]);

    // The old read link no longer opens; the new one does, and sees what
    // the editor writes after the rotation.
    await expect(
      connectDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: await as(documentId, "read"),
        channels: [{ channel: "content", doc: new LoroDoc() }],
        socketFactory: nodeWebSocketFactory,
      }),
    ).rejects.toMatchObject({ code: 4401 });
    editSecrets.set(documentId, next);
    const newReader = new LoroDoc();
    const renewedReader = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "read"),
      channels: [{ channel: "content", doc: newReader }],
      socketFactory: nodeWebSocketFactory,
    });
    contentEditor.getText("content").insert(0, "after rotation");
    contentEditor.commit();
    await eventually(
      () => newReader.getText("content").toString() === "after rotation",
    );

    editor.close();
    reader.close();
    renewedReader.close();
  }, 20000);

  test("decision 10: a reviewer's blob that isn't a Loro update blocks no one", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const content = new LoroDoc();
    const editor = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "edit"),
      channels: [{ channel: "content", doc: content }],
      socketFactory: nodeWebSocketFactory,
    });
    content.getText("content").insert(0, "still readable");
    content.commit();

    // A reviewer, key in hand, publishes garbage on its own channel.
    const reviewer = await as(documentId, "suggest");
    const raw = nodeWebSocketFactory(WS_URL);
    const acked = new Promise<void>((resolve) => {
      raw.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.includes("seq")) {
          resolve();
        }
      };
    });
    raw.onopen = async () => {
      raw.send(encodeAuthMessage(documentId, "suggest", reviewer.secret));
      raw.send(
        encodeFrame("annotations", await encrypt(key, new Uint8Array([1, 2]))),
      );
    };
    await acked;
    raw.close();
    await wait(200);

    const newcomer = { content: new LoroDoc(), annotations: new LoroDoc() };
    const invalid: string[] = [];
    const reader = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "read"),
      channels: [
        { channel: "content", doc: newcomer.content },
        { channel: "annotations", doc: newcomer.annotations },
      ],
      socketFactory: nodeWebSocketFactory,
      onInvalidEntry: (channel) => invalid.push(channel),
    });

    expect(newcomer.content.getText("content").toString()).toBe(
      "still readable",
    );
    expect(invalid).toEqual(["annotations"]);
    editor.close();
    reader.close();
  }, 20000);

  // Phase 9, 9c.4: what a reviewer, then an editor, may journal to harm
  // the others — bytes that aren't Loro, a truncated update, a blob that
  // doesn't decrypt, an annotation whose cursor traps Loro (D-37), history
  // tables Loro throws on (D-19, D-20), decision records no client accepts
  // — leaves the document open to everyone: a page that was open, one
  // that resumes, newcomers of every role, and newcomers after the next
  // compaction.
  test("9c.4: hostile entries journaled by a reviewer and an editor make the document unopenable for no one", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const fatal: unknown[] = [];
    const invalid = new Map<string, number>();
    const open = async (
      role: Role,
      author: string,
      socketFactory: SocketFactory = nodeWebSocketFactory,
    ) => {
      const panelParent = document.createElement("div");
      const opened = await openDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: await as(documentId, role),
        editorParent: document.createElement("div"),
        panelParent,
        author: () => author,
        onFatal: (error) => fatal.push(error),
        onInvalidEntry: () =>
          invalid.set(author, (invalid.get(author) ?? 0) + 1),
        socketFactory,
      });
      return {
        ...opened,
        view: opened.client.editor.view,
        text: () => opened.client.editor.view.state.doc.toString(),
        items: () =>
          Array.from(panelParent.querySelectorAll(".annotation-item")).map(
            (item) => item.textContent ?? "",
          ),
      };
    };
    type Page = Awaited<ReturnType<typeof open>>;
    /** Everything a page shows of the document, read as it would: the
     * text, the panel, the history and each named version's text. */
    const readable = (page: Page, text: string) => {
      if (page.text() !== text) return false;
      if (!page.items().some((item) => item.includes("honest note"))) {
        return false;
      }
      for (const entry of new HistoryModel(
        page.contentDoc,
        page.annotationsDoc,
      ).entries()) {
        if (entry.kind === "named" && !entry.available) continue;
        textAt(page.contentDoc, entry.frontiers);
      }
      page.contentDoc.export({ mode: "snapshot" }); // still usable
      return true;
    };

    // The document as honest clients make it.
    const editor = await open("edit", "alice");
    editor.view.dispatch({
      changes: { from: 0, insert: "hello world" },
      userEvent: "input.type",
    });
    const reviewer = await open("suggest", "bob");
    await eventually(() => reviewer.text() === "hello world");
    tryCreateAnnotation(reviewer.contentDoc, reviewer.annotationsDoc, {
      type: "comment",
      start: 0,
      end: 5,
      body: "honest note",
      author: "bob",
    });
    await eventually(() => readable(editor, "hello world"));
    const reader = await open("read", "carol");
    const tracked = createTrackedNodeWebSocketFactory();
    const resuming = await open("read", "dave", tracked.factory);
    await eventually(
      () =>
        readable(reader, "hello world") && readable(resuming, "hello world"),
    );
    // Cut off while the hostile entries are journaled: it resumes by its
    // cursor, and imports them from a history reply.
    tracked.killLast();

    /** Publishes `blobs` as one client of `role` would, each encrypted
     * unless raw, and waits for every ack. */
    const publishRaw = async (
      role: Role,
      frames: { channel: ChannelName; blob: Uint8Array; raw?: true }[],
    ) => {
      const { secret } = await as(documentId, role);
      const socket = nodeWebSocketFactory(WS_URL);
      let acks = 0;
      const done = new Promise<void>((resolve) => {
        socket.onmessage = (event) => {
          if (typeof event.data === "string" && event.data.includes('"ack"')) {
            if (++acks === frames.length) resolve();
          }
        };
      });
      socket.onopen = async () => {
        socket.send(encodeAuthMessage(documentId, role, secret));
        for (const { channel, blob, raw } of frames) {
          socket.send(
            encodeFrame(channel, raw ? blob : await encrypt(key, blob)),
          );
        }
      };
      await done;
      socket.close();
    };

    // A reviewer's update, from a peer of its own: an annotation whose
    // cursors trap Loro, a version and a pseudonym at a peer beyond 64
    // bits.
    const hostile = new LoroDoc();
    const trap = hostileCursorBytes();
    const entry = hostile
      .getMap("annotations")
      .setContainer("trap", new LoroMap());
    for (const [field, value] of Object.entries({
      type: "comment",
      author: "mallory",
      status: "open",
      createdAt: 1,
      startCursor: trap,
      endCursor: trap,
      endOnLastChar: false,
      body: "trap",
    })) {
      entry.set(field, value);
    }
    const version = hostile
      .getMap("versions")
      .setContainer("hostile", new LoroMap());
    version.set("name", "hostile");
    version.set("author", "mallory");
    version.set("at", 1);
    version.set("frontiers", [{ peer: "18446744073709551616", counter: 0 }]);
    hostile.getMap("peers").set("18446744073709551616", "mallory");
    hostile.commit();
    const update = hostile.export({ mode: "update" });
    await publishRaw("suggest", [
      { channel: "annotations", blob: update },
      { channel: "annotations", blob: new Uint8Array([1, 2]) },
      { channel: "annotations", blob: update.slice(0, update.length >> 1) },
      { channel: "annotations", blob: new Uint8Array(40).fill(7), raw: true },
    ]);

    // An editor's: on content, on decisions.
    const typed = editor.contentDoc.fork();
    typed.setPeerId(999n);
    typed.getText("content").insert(0, "never ");
    typed.commit();
    const contentUpdate = typed.export({
      mode: "update",
      from: editor.contentDoc.oplogVersion(),
    });
    const record = (text: string) => new TextEncoder().encode(text);
    await publishRaw("edit", [
      { channel: "content", blob: new Uint8Array([1, 2]) },
      { channel: "content", blob: contentUpdate.slice(0, -3) },
      { channel: "content", blob: new Uint8Array(40).fill(7), raw: true },
      { channel: "decisions", blob: record("not json") },
      {
        channel: "decisions",
        blob: record(
          '{"proposalId":"p","annotationId":"trap","decision":"resolve","author":"\\ud800"}',
        ),
      },
      {
        channel: "decisions",
        blob: record(
          '{"proposalId":"q","annotationId":"trap","decision":"accept","author":"m","change":"AQ"}',
        ),
      },
      { channel: "decisions", blob: new Uint8Array(40).fill(7), raw: true },
    ]);

    // P5 (threat model): one key encrypts every channel, with no
    // associated data. Blobs journaled on one channel, replayed as they
    // are (still encrypted) on another, as each role may publish there.
    const journaled = async (channel: ChannelName) => {
      const [first] = await joinRawAndGetHistory(documentId, channel);
      if (!first) throw new Error(`nothing journaled on ${channel}`);
      return first.blob;
    };
    const replayed = {
      content: await journaled("content"),
      annotations: await journaled("annotations"),
      decisions: await journaled("decisions"),
    };
    await publishRaw("suggest", [
      { channel: "annotations", blob: replayed.content, raw: true },
      { channel: "annotations", blob: replayed.decisions, raw: true },
    ]);
    await publishRaw("edit", [
      { channel: "content", blob: replayed.annotations, raw: true },
      { channel: "content", blob: replayed.decisions, raw: true },
      { channel: "decisions", blob: replayed.content, raw: true },
      { channel: "decisions", blob: replayed.annotations, raw: true },
    ]);

    // Open pages, live: still readable, and still editable.
    editor.view.dispatch({
      changes: { from: 11, insert: "!" },
      userEvent: "input.type",
    });
    await eventually(
      () =>
        readable(editor, "hello world!") &&
        readable(reviewer, "hello world!") &&
        readable(reader, "hello world!") &&
        readable(resuming, "hello world!"),
    );
    // Newcomers of every role.
    const newcomers = [
      await open("read", "erin"),
      await open("suggest", "frank"),
      await open("edit", "grace"),
    ];
    await eventually(() =>
      newcomers.every((page) => readable(page, "hello world!")),
    );

    // Checked: closed, so that polling the journal below stays far from
    // the document's 32 connections (W-43).
    for (const page of [reviewer, reader, resuming, ...newcomers]) {
      page.connection.close();
    }

    // The next compaction, by an editor: what was journaled is folded
    // into its snapshot, the trap entry and the hostile tables included.
    const compactor = {
      content: new LoroDoc(),
      annotations: new LoroDoc(),
    };
    const compacting = await connectDocument({
      url: WS_URL,
      documentId,
      key,
      credentials: await as(documentId, "edit"),
      channels: [
        { channel: "content", doc: compactor.content },
        { channel: "annotations", doc: compactor.annotations },
      ],
      socketFactory: nodeWebSocketFactory,
      compactionThreshold: 2,
    });
    const before = {
      content: (await joinRawAndGetHistory(documentId, "content")).length,
      annotations: (await joinRawAndGetHistory(documentId, "annotations"))
        .length,
    };
    for (const channel of ["content", "annotations"] as const) {
      const doc = compactor[channel];
      for (let i = 0; i < 3; i++) {
        doc.getMap("touched").set(`by${i}`, "compactor");
        doc.commit();
        await wait(100);
      }
    }
    const compacted = async () =>
      (await joinRawAndGetHistory(documentId, "content")).length <
        before.content &&
      (await joinRawAndGetHistory(documentId, "annotations")).length <
        before.annotations;
    for (let attempt = 0; !(await compacted()); attempt++) {
      if (attempt > 20) throw new Error("no compaction");
      await wait(100);
    }
    compacting.close();
    const late = [await open("read", "heidi"), await open("edit", "ivan")];
    await eventually(() =>
      late.every((page) => readable(page, "hello world!")),
    );

    expect(fatal).toEqual([]);
    // Each page saw unreadable entries, and went on.
    for (const name of ["alice", "carol", "dave", "erin", "grace", "heidi"]) {
      expect(invalid.get(name) ?? 0, name).toBeGreaterThan(0);
    }
    for (const page of [editor, ...late]) {
      page.connection.close();
    }
  }, 30000);

  // docs/phase-5-modele-acces.md step 6: one client per role, each opened
  // as the page opens it (`openDocument`: editor, panel, effects by role).
  test("phase 5: a reviewer proposes, an editor accepts, a reader sees the result; a rotation cuts reader and reviewer for good", async () => {
    const key = await generateKey();
    const documentId = await createDocument();
    const sockets: Record<Role, number> = { read: 0, suggest: 0, edit: 0 };
    const refused: Record<Role, number[]> = { read: [], suggest: [], edit: [] };
    const renewed: Uint8Array[] = [];
    const open = async (role: Role, author: string) => {
      const panelParent = document.createElement("div");
      const opened = await openDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: await as(documentId, role),
        onRefused: (code) => refused[role].push(code),
        onRenewed: (secret) => renewed.push(secret),
        editorParent: document.createElement("div"),
        panelParent,
        author: () => author,
        socketFactory: (url) => {
          sockets[role]++;
          return nodeWebSocketFactory(url);
        },
      });
      const control = <T extends Element>(selector: string): T => {
        const found = panelParent.querySelector<T>(selector);
        if (!found) throw new Error(`${role}: no ${selector}`);
        return found;
      };
      const showAll = () =>
        panelParent
          .querySelector<HTMLButtonElement>(
            '.annotations-filter [data-filter="all"]',
          )
          ?.click();
      return {
        ...opened,
        control,
        view: opened.client.editor.view,
        text: () => opened.client.editor.view.state.doc.toString(),
        // Every card, open and closed (ADR-0052 §1).
        items: () => {
          showAll();
          return Array.from(
            panelParent.querySelectorAll(".annotation-item"),
            (item) => item.textContent ?? "",
          );
        },
        states: () => {
          showAll();
          return Array.from(
            panelParent.querySelectorAll<HTMLElement>(".annotation-item"),
            (item) => item.dataset.state,
          );
        },
      };
    };

    const editor = await open("edit", "alice");
    editor.view.dispatch({
      changes: { from: 0, insert: "hello world again" },
      userEvent: "input.type",
    });
    const reviewer = await open("suggest", "bob");
    const reader = await open("read", "carol");
    await eventually(
      () =>
        reviewer.text() === "hello world again" &&
        reader.text() === "hello world again",
    );
    expect(reader.view.state.readOnly).toBe(true);
    expect(reviewer.view.state.readOnly).toBe(true);

    // Through the panel's action, the reviewer proposes to add " dear" after
    // "hello" and to delete " again".
    const propose = (type: string, from: number, to: number, extra = "") => {
      reviewer.view.dispatch({ selection: { anchor: from, head: to } });
      reviewer.client.panel.create(type as AnnotationType, extra, "");
    };
    propose("addition", 5, 5, " dear");
    propose("deletion", 11, 17);
    expect(reviewer.text()).toBe("hello world again"); // content untouched

    await eventually(() => editor.items().length === 2);
    for (let i = 0; i < 2; i++) {
      editor.control<HTMLButtonElement>('button[data-action="accept"]').click();
    }

    // Reader and reviewer apply nothing (decision 2): the deletion comes
    // from the editor's operations, the addition from the change it
    // adopted and published on content.
    await eventually(
      () =>
        reader.text() === "hello dear world" &&
        reader.states().every((state) => state === "accepted") &&
        reviewer.text() === "hello dear world",
    );
    expect(editor.text()).toBe("hello dear world");
    // Neither reader nor reviewer ever wrote an operation of their own on
    // content, and the server refused nobody.
    for (const client of [reader, reviewer]) {
      expect(
        client.contentDoc.oplogVersion().get(client.contentDoc.peerIdStr),
      ).toBeUndefined();
    }
    expect(refused).toEqual({ read: [], suggest: [], edit: [] });

    // Rotation from the editor, as the share screen does it.
    const opened = { ...sockets };
    await renewLinks(documentId, editor.connection, window.localStorage);
    await eventually(
      () =>
        renewed.length === 1 &&
        refused.read.length === 1 &&
        refused.suggest.length === 1,
    );
    expect(refused).toEqual({ read: [4410], suggest: [4410], edit: [] });
    await wait(1000); // past the reconnect delay (500 ms)
    // Reader and reviewer stay cut off; the editor came back once, with
    // its new link.
    expect(sockets).toEqual({ ...opened, edit: opened.edit + 1 });

    await expect(
      connectDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: await as(documentId, "read"),
        channels: [{ channel: "content", doc: new LoroDoc() }],
        socketFactory: nodeWebSocketFactory,
      }),
    ).rejects.toMatchObject({ code: 4401 });
    const [next] = renewed;
    if (!next) throw new Error("no new edit secret");
    editSecrets.set(documentId, next);
    editor.view.dispatch({
      changes: { from: editor.text().length, insert: "!" },
      userEvent: "input.type",
    });
    const newReader = await open("read", "dave");
    await eventually(() => newReader.text() === "hello dear world!");
    expect(newReader.items()).toHaveLength(2);
    expect(newReader.items().join()).not.toContain("waiting for an editor");
    // Cut off, the old reader never received what followed.
    expect(reader.text()).toBe("hello dear world");

    for (const client of [editor, reviewer, reader, newReader]) {
      client.connection.close();
    }
  }, 20000);

  test("phase 6: an editor writes every extension, a reader opens it on the preview, a reviewer's export imported into a new document gives the same text and annotations", async () => {
    const key = await generateKey();
    const open = async (documentId: string, role: Role, author: string) => {
      const editorParent = document.createElement("div");
      const panelParent = document.createElement("div");
      const opened = await openDocument({
        url: WS_URL,
        documentId,
        key,
        credentials: await as(documentId, role),
        editorParent,
        panelParent,
        author: () => author,
        socketFactory: nodeWebSocketFactory,
      });
      return {
        ...opened,
        editorParent,
        panelParent,
        view: opened.client.editor.view,
        text: () => opened.client.editor.view.state.doc.toString(),
        exported: () =>
          exportMarkdown(
            opened.client.editor.view.state.doc.toString(),
            opened.client.index.current(),
          ),
      };
    };

    const source = [
      "# Every extension",
      "",
      "Text with a note[^1], ~~struck~~, and $e^{i\\pi}+1=0$; prices: 5 $ and 10 $.",
      "",
      "$$",
      "\\int_0^1 x^2\\,dx",
      "$$",
      "",
      "> - quoted item",
      ">   1. ordered",
      ">      > quote in list in quote",
      "",
      "- [ ] to do",
      "- [x] done",
      "  - [ ] nested task",
      "",
      "| a | formula |",
      "|---|:-:|",
      "| 1 | $a^2$ |",
      "",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
      "",
      "![remote](https://tracker.example/p.png)",
      "",
      "[^1]: The note, with $x$.",
      "",
    ].join("\n");
    const documentId = await createDocument();
    const editor = await open(documentId, "edit", "alice");
    editor.view.dispatch({
      changes: { from: 0, insert: source },
      userEvent: "input.type",
    });

    // The reader opens on the preview, rendered from what came through
    // the server.
    const reader = await open(documentId, "read", "carol");
    const preview = reader.editorParent.querySelector<HTMLElement>(".preview");
    // Rendered once the text has stayed unchanged for a moment.
    await eventually(() => preview?.querySelector("section.footnotes") != null);
    await reader.client.views.preview.settled();
    expect(preview?.hidden).toBe(false);
    expect(reader.view.dom.hidden).toBe(true);
    const all = (selector: string) =>
      Array.from(preview?.querySelectorAll(selector) ?? []);
    expect(all("h1").map((h) => h.textContent)).toEqual(["Every extension"]);
    expect(all("s").map((s) => s.textContent)).toEqual(["struck"]);
    expect(all("blockquote li ol li blockquote p")[0]?.textContent).toBe(
      "quote in list in quote",
    );
    expect(
      all("li.task-list-item input").map(
        (box) => (box as HTMLInputElement).checked,
      ),
    ).toEqual([false, true, false]);
    expect(all("table td .math .katex")).toHaveLength(1);
    // Three inline formulas and one display one; the dollars stay text.
    expect(all(".math .katex")).toHaveLength(4);
    expect(preview?.textContent).toContain("prices: 5 $ and 10 $.");
    expect(all("section.footnotes li")[0]?.id).toBe("fn-md-1");
    // Drawn by Pele itself (ADR-0042), in place: no frame.
    expect(all(".mermaid > svg.pele-flowchart")).toHaveLength(1);
    expect(all("iframe")).toHaveLength(0);
    expect(all("img")).toHaveLength(0);
    expect(all("a.remote-image")[0]?.getAttribute("href")).toBe(
      "https://tracker.example/p.png",
    );

    // A reviewer comments on the title and proposes an addition.
    const reviewer = await open(documentId, "suggest", "bob");
    await eventually(() => reviewer.text() === source);
    createAnnotation(reviewer.contentDoc, reviewer.annotationsDoc, {
      type: "comment",
      start: 2,
      end: 7,
      author: "bob",
      body: "a better title?",
    });
    suggestAddition(reviewer.contentDoc, reviewer.annotationsDoc, {
      at: 17,
      text: " there is",
      author: "bob",
    });
    await eventually(
      () => editor.client.index.current().annotations.length === 2,
    );
    const exported = reviewer.exported();
    expect(exported).toMatchObject({
      kind: "exported",
      omitted: 0,
      ambiguous: false,
    });
    if (exported.kind !== "exported") return;
    expect(exported.markdown).toContain("{==Every==}[^cm-1]");
    expect(extractNotes(exported.markdown).notes.get("cm-1")?.[0]?.text).toBe(
      "a better title?",
    );
    expect(exported.markdown).toContain("{++ there is++}");

    // An editor imports that file into a new document, through the page's
    // own file input.
    const importedId = await createDocument();
    const importer = await open(importedId, "edit", "dave");
    const input =
      importer.editorParent.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("no import in an empty document");
    Object.defineProperty(input, "files", {
      value: [new File([exported.markdown], "document.md")],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await eventually(() => importer.text() === source);

    // A new reader of that document: same text, same annotations.
    const newReader = await open(importedId, "read", "erin");
    await eventually(
      () => JSON.stringify(newReader.exported()) === JSON.stringify(exported),
    );
    expect(newReader.text()).toBe(source);

    for (const client of [editor, reader, reviewer, importer, newReader]) {
      client.connection.close();
    }
  }, 30000);

  // docs/phase-8-protocole-ouvert.md, 8c.3: the reference library, built
  // for Node, used by a script that knows only its entry and a link.
  test("phase 8c: the library's Node example reads and writes a document of the real server", async () => {
    const webDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const node = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          args,
          { cwd: webDir },
          (error, stdout, stderr) =>
            error
              ? reject(new Error(`${error.message}\n${stderr}`))
              : resolve(stdout),
        ),
      );
    await node(["lib/build.mjs"]);

    // The page lives where the server is (K-3): the link alone finds it.
    const created = await createRegisteredDocument(BASE_URL);
    const links = await documentLinks(
      `${BASE_URL}/`,
      created.documentId,
      created.keyMaterial,
      created.editSecret,
    );
    const editor = await openLink(links.edit, {
      socketFactory: nodeWebSocketFactory,
    });
    editor.content.getText("content").insert(0, "hello");
    editor.content.commit();
    createAnnotation(editor.content, editor.annotations, {
      type: "comment",
      start: 0,
      end: 5,
      author: "alice",
      body: "hi",
    });
    await editor.whenPublished();

    const printed = await node([
      "lib/examples/read-and-write.mjs",
      links.edit,
      " from node",
    ]);

    expect(printed).toContain(`document ${created.documentId}, as edit`);
    expect(printed).toContain("hello");
    expect(printed).toContain("[comment] alice (open)");
    expect(printed).toContain('appended " from node"');
    await eventually(
      () => editor.content.getText("content").toString() === "hello from node",
    );
    editor.close();
  }, 30000);
});
