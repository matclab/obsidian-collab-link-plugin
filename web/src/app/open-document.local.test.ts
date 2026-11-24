// @vitest-environment jsdom
//
// The page's local persistence (ADR-0022), through `openDocument` as the
// page runs it: a stored record fills the docs before the editor exists,
// saves follow changes, a second tab keeps nothing.
import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, onTestFinished, test } from "vitest";
import { encodeProposal } from "../../lib/src/annotations/index.js";
import { generateKey } from "../../lib/src/crypto/aead.js";
import {
  draftAnnotation,
  updateStatus,
  writeAnnotation,
} from "../../lib/src/index.js";
import type { SocketLike } from "../../lib/src/transport/index.js";
import { CloseCode, ConnectionRefused } from "../../lib/src/transport/index.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { EDITOR } from "../../lib/src/transport/test-support/credentials.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { counter, resetCounters } from "../perf/index.js";
import {
  type LocalRecord,
  openLocalState,
  storeName,
} from "../storage/index.js";
import { FakeLocks } from "../storage/test-support/fake-locks.js";
import { type LocalStatus, openDocument } from "./open-document.js";
import type { WiredClient } from "./wire-client.js";

function unreachable(): SocketLike {
  return {
    send() {
      throw new Error("not connected");
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
  };
}

async function setUp() {
  const key = await generateKey();
  const server = new FakeServer();
  const indexedDB = new IDBFactory();
  const locks = new FakeLocks();
  const network = { up: true };
  const where = { documentId: "doc", role: "edit" as const };
  /** What the pages have in progress (AGENTS.md §1.6): their connections,
   * their saves; and WebCrypto. */
  const activity = new ActivityCount();
  onTestFinished(activity.countCrypto());

  /** Opens a page; `flushes` gets its flush (the page hiding). */
  function page(
    options: {
      onWired?: (client: WiredClient) => void;
      lock?: FakeLocks;
      onFatal?: (error: unknown) => void;
    } = {},
  ) {
    const statuses: LocalStatus[] = [];
    const unsent: number[] = [];
    let flush: () => void = () => {};
    const opening = openDocument({
      url: "wss://fake/ws",
      documentId: where.documentId,
      key,
      credentials: EDITOR,
      editorParent: document.createElement("div"),
      panelParent: document.createElement("div"),
      author: () => "me",
      socketFactory: () => (network.up ? server.connect() : unreachable()),
      activity,
      local: {
        indexedDB,
        lock: options.lock ?? locks,
        saveDelayMs: 20,
        onStatus: (status) => statuses.push(status),
        onUnsent: (count) => unsent.push(count),
        flushOn: (given) => {
          flush = given;
        },
      },
      ...(options.onWired && { onWired: options.onWired }),
      ...(options.onFatal && { onFatal: options.onFatal }),
    });
    return { opening, statuses, unsent, flush: () => flush() };
  }

  /** The page dies: its lock goes with it. */
  const unload = () => locks.release(storeName(where));

  function offline(): void {
    network.up = false;
    server.disconnectAll();
  }

  /** Waits until the record written on the device — not only captured:
   * the write ends after, encrypted then put — satisfies `holds`; a page
   * that dies before loses its write (ADR-0022). Read beside the page's
   * lock, which it holds. */
  async function written(holds: (record: LocalRecord) => boolean) {
    await activity.settled();
    const state = await openLocalState({
      ...where,
      key,
      indexedDB,
      lock: new FakeLocks(),
    });
    const record = state.kind === "owner" ? state.record : undefined;
    if (state.kind === "owner") state.release();
    expect(record && holds(record)).toBe(true);
  }

  return {
    key,
    server,
    network,
    page,
    unload,
    offline,
    written,
    settled: () => activity.settled(),
  };
}

/** The text a record keeps. */
function keptText(record: LocalRecord): string {
  const doc = new LoroDoc();
  for (const channel of record.channels) {
    if (channel.channel === "content") doc.import(channel.snapshot);
  }
  return doc.getText("content").toString();
}

const text = (client: WiredClient) => client.editor.view.state.doc.toString();

describe("openDocument with local persistence", () => {
  test("offline edits survive a reload, show before the server replies, then reach the server", async () => {
    const t = await setUp();
    const first = t.page();
    const opened = await first.opening;
    expect(first.statuses).toEqual(["persisted"]);
    t.offline();
    opened.contentDoc.getText("content").insert(0, "written offline");
    opened.contentDoc.commit();
    first.flush();
    await t.written((record) => keptText(record) === "written offline");
    opened.connection.close();
    t.unload();

    t.network.up = true;
    let shownAtWiring = "";
    const second = t.page({
      onWired: (client) => {
        shownAtWiring = text(client);
      },
    });
    const reopened = await second.opening;
    expect(shownAtWiring).toBe("written offline");
    // Everything kept reaches the server: the text, and the page's peers,
    // registered at its first edit (ID-18), saved too once nothing is in
    // progress any more.
    await t.settled();
    expect(t.server.entries("doc").map((entry) => entry.channel)).toEqual([
      "content",
      "annotations",
    ]);
    expect(second.unsent.at(-1)).toBe(0);
    expect(reopened.contentDoc.peerIdStr).not.toBe(opened.contentDoc.peerIdStr);
    reopened.connection.close();
  });

  test("a Loro panic halts the page: told once, nothing more sent nor saved (phase 9, L4)", async () => {
    const t = await setUp();
    const fatal: unknown[] = [];
    const first = t.page({ onFatal: (error) => fatal.push(error) });
    const opened = await first.opening;
    opened.contentDoc.getText("content").insert(0, "kept");
    opened.contentDoc.commit();
    first.flush();
    await eventually(() => t.server.journaled("doc") > 0);
    await eventually(() => first.unsent.at(-1) === 0);
    const journaled = t.server.journaled("doc"); // the text, the peer table

    const trap = new WebAssembly.RuntimeError("unreachable");
    opened.halt(trap);
    opened.halt(trap);
    expect(fatal).toEqual([trap]);
    opened.contentDoc.getText("content").insert(0, "after the panic, ");
    opened.contentDoc.commit();
    first.flush();
    // Nothing in progress: no publication, no save waiting.
    await t.settled();
    expect(t.server.journaled("doc")).toBe(journaled);
    t.unload();

    // Shown at wiring: what the device kept, before any connection.
    let shownAtWiring = "";
    const second = t.page({
      onWired: (client) => {
        shownAtWiring = text(client);
      },
    });
    const reopened = await second.opening;
    expect(shownAtWiring).toBe("kept");
    reopened.connection.close();
  });

  // Phase 9, R3: a panic raised where the page catches errors itself (the
  // annotations' listeners) halts it too.
  test("a Loro panic in a listener of the annotations halts the page", async () => {
    const t = await setUp();
    const fatal: unknown[] = [];
    const opened = await t.page({ onFatal: (error) => fatal.push(error) })
      .opening;
    const trap = new WebAssembly.RuntimeError("unreachable");
    opened.client.index.subscribe(() => {
      throw trap;
    });
    opened.annotationsDoc.getMap("annotations").set("x", 1);
    opened.annotationsDoc.commit();
    await eventually(() => fatal.length > 0);
    expect(fatal).toEqual([trap]);
    t.unload();
  });

  test("what I set aside survives a reload, for the open annotations only (ADR-0050 §4)", async () => {
    const t = await setUp();
    const first = t.page();
    const opened = await first.opening;
    const comment = (at: number) => {
      const draft = draftAnnotation(opened.contentDoc, {
        type: "comment",
        start: at,
        end: at + 1,
        author: "Bob",
        body: "?",
      });
      writeAnnotation(opened.annotationsDoc, draft);
      return draft.id;
    };
    opened.contentDoc.getText("content").insert(0, "some text");
    opened.contentDoc.commit();
    const kept = comment(0);
    const resolved = comment(2);
    updateStatus(opened.annotationsDoc, resolved, "resolved");
    // Everything sent and saved, no capture for ten save delays: what
    // follows is saved only if setting aside asks for it.
    await eventually(() => first.unsent.at(-1) === 0);
    await t.settled();
    opened.client.setAside.set(kept, kept);
    opened.client.setAside.set(resolved, resolved);
    opened.client.setAside.set("gone", "gone");
    // Saved by itself, after its delay: no other change asks for it.
    await t.written(
      (record) => record.setAside?.some(([id]) => id === kept) ?? false,
    );
    opened.connection.close();
    t.unload();

    const reopened = await t.page().opening;
    expect(reopened.client.setAside.get(kept)).toBe(kept);
    expect(reopened.client.setAside.get(resolved)).toBeUndefined();
    expect(reopened.client.setAside.get("gone")).toBeUndefined();
    reopened.connection.close();
  });

  test("changes carry their time (history, phase 7b)", async () => {
    const t = await setUp();
    const opened = await t.page().opening;
    const before = Math.floor(Date.now() / 1000);
    opened.contentDoc.getText("content").insert(0, "dated");
    opened.contentDoc.commit();
    const change = opened.contentDoc.getChangeAt({
      peer: opened.contentDoc.peerIdStr,
      counter: 0,
    });
    expect(change.timestamp).toBeGreaterThanOrEqual(before);
    opened.connection.close();
  });

  test("a second tab keeps nothing, and says so", async () => {
    const t = await setUp();
    const firstPage = t.page();
    const first = await firstPage.opening;
    const secondPage = t.page();
    const second = await secondPage.opening;
    expect(secondPage.statuses).toEqual(["other-tab"]);

    t.offline(); // neither hears of the other's edits
    first.contentDoc.getText("content").insert(0, "first");
    first.contentDoc.commit();
    second.contentDoc.getText("content").insert(0, "second");
    second.contentDoc.commit();
    secondPage.flush();
    firstPage.flush();
    await t.written((record) => keptText(record) === "first");
    expect(secondPage.unsent).toEqual([]);
    first.connection.close();
    second.connection.close();
    t.unload();

    // The next page reads the first tab's record, never the second's.
    let shown = "";
    void t.page({
      onWired: (client) => {
        shown = text(client);
      },
    }).opening;
    await eventually(() => shown !== "");
    expect(shown).toBe("first");
  });

  test("confirmed decisions are kept: after a reload, the log has them before any reply", async () => {
    const t = await setUp();
    const first = t.page();
    const opened = await first.opening;
    const record = encodeProposal({
      proposalId: "p1",
      annotationId: "a1",
      decision: "reject",
      author: "me",
    });
    opened.connection.publishDecision(record);
    await eventually(() => opened.client.log.winner("a1") !== undefined);
    first.flush();
    await t.written((record) => record.decisions.confirmed.length > 0);
    opened.connection.close();
    t.unload();

    let atWiring: unknown;
    t.offline(); // no reply can bring it
    void t.page({
      onWired: (client) => {
        atWiring = client.log.winner("a1")?.decision;
      },
    }).opening;
    await eventually(() => atWiring !== undefined);
    expect(atWiring).toBe("reject");
  });

  test("a refused link leaves the record for the next one", async () => {
    const t = await setUp();
    const first = t.page();
    const opened = await first.opening;
    t.offline();
    opened.contentDoc.getText("content").insert(0, "kept");
    opened.contentDoc.commit();
    first.flush();
    await t.written((record) => keptText(record) === "kept");
    opened.connection.close();
    t.unload();

    t.network.up = true;
    t.server.checkAuth = () => CloseCode.Unauthenticated;
    const refused = t.page();
    await expect(refused.opening).rejects.toBeInstanceOf(ConnectionRefused);
    // "kept" and the page's peers registered: told, for its message.
    expect(refused.unsent.at(-1)).toBe(6);
    t.unload();

    t.server.checkAuth = () => undefined;
    const next = await t.page().opening;
    await t.settled();
    expect(t.server.entries("doc").map((entry) => entry.channel)).toEqual([
      "content",
      "annotations",
    ]);
    next.connection.close();
  });

  // AGENTS.md §6: a keystroke costs no snapshot export; a burst, one save.
  test("budget: a keystroke exports nothing at once; a burst of typing, one capture", async () => {
    const t = await setUp();
    const first = t.page();
    const opened = await first.opening;
    await t.settled(); // opening saves
    resetCounters();
    const content = opened.contentDoc.getText("content");
    for (let i = 0; i < 20; i++) {
      content.insert(i, "x");
      opened.contentDoc.commit();
      expect(counter("storage.capture")).toBe(0);
    }
    await t.settled();
    expect(counter("storage.capture")).toBeGreaterThanOrEqual(1);
    // The burst, then at most one more for the acks of its frames.
    expect(counter("storage.capture")).toBeLessThanOrEqual(2);
    opened.connection.close();
  });
});
