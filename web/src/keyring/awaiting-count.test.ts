// What awaits my reply in a document of « Mes documents », without opening
// it (ADR-0060 §2; phase 34, NT1, NT3, NT5): from its copy on the device,
// caught up; nothing written, neither in the copy nor on the wire; nothing
// without a copy, for a link refused, a server that doesn't answer.
import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  type DocumentConnection,
  connectDocument,
  draftAnnotation,
  draftReply,
  exportKeyToBase64Url,
  formatLinkFragment,
  generateKey,
  writeAnnotation,
  writeReply,
} from "../../lib/src/index.js";
import { ActivityCount } from "../../lib/src/transport/test-support/activity-count.js";
import { EDITOR } from "../../lib/src/transport/test-support/credentials.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { FakeServer } from "../../lib/src/transport/test-support/fake-server.js";
import { openLocalState, peekLocalRecord } from "../storage/index.js";
import { FakeLocks } from "../storage/test-support/fake-locks.js";
import { PageMe } from "../view-model/page-me.js";
import { countAwaiting, readOnlyResume } from "./awaiting-count.js";

const DOC = "doc-1";

async function setUp() {
  const server = new FakeServer();
  const indexedDB = new IDBFactory();
  const key = await generateKey();
  const link = `https://collab.example/?doc=${DOC}${formatLinkFragment({
    key: await exportKeyToBase64Url(key),
    role: "edit",
    secret: EDITOR.secret,
  })}`;
  const timers: (() => void)[] = [];
  const env = {
    indexedDB,
    me: new PageMe("Alice"),
    setTimer: (run: () => void) => {
      timers.push(run);
      return () => {
        const at = timers.indexOf(run);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    socketFactory: () => server.connect(),
    activity: new ActivityCount(),
  };
  /** Another participant, connected: what it writes reaches the server. */
  const other = async () => {
    const content = new LoroDoc();
    const annotations = new LoroDoc();
    const connection = await connectDocument({
      url: "wss://fake",
      documentId: DOC,
      key,
      credentials: EDITOR,
      channels: [
        { channel: "content", doc: content },
        { channel: "annotations", doc: annotations },
      ],
      socketFactory: () => server.connect(),
    });
    return { content, annotations, connection };
  };
  /** A copy kept on this device of the document as `content` and
   * `annotations` hold it, at cursor `cursor`, with something of its own
   * left to send. */
  const keep = async (
    content: LoroDoc,
    annotations: LoroDoc,
    cursor: number,
  ) => {
    const locks = new FakeLocks();
    const state = await openLocalState({
      documentId: DOC,
      role: "edit",
      key,
      indexedDB,
      lock: locks,
    });
    if (state.kind !== "owner") throw new Error(state.kind);
    const pending = { peer: "123", acked: 0 };
    await state.save({
      channels: [
        {
          channel: "content",
          snapshot: content.export({ mode: "snapshot" }),
          cursor,
          own: [pending],
          adopted: [],
        },
        {
          channel: "annotations",
          snapshot: annotations.export({ mode: "snapshot" }),
          cursor,
          own: [pending],
          adopted: [],
        },
      ],
      decisions: { cursor: 0, confirmed: [], outbox: [new Uint8Array([1])] },
    });
    return state;
  };
  const entry = { documentId: DOC, role: "edit" as const, link };
  return { server, env, entry, other, keep, timers, key, indexedDB };
}

const comment = (content: LoroDoc, annotations: LoroDoc, author: string) => {
  const draft = draftAnnotation(content, {
    type: "comment",
    start: 0,
    end: 1,
    author,
    body: "?",
  });
  writeAnnotation(annotations, draft);
  return draft.id;
};

describe("what awaits me in a document of « Mes documents »", () => {
  test("its copy, caught up: another's reply since counts", async () => {
    const s = await setUp();
    const peer = await s.other();
    peer.content.getText("content").insert(0, "Hello");
    peer.content.commit();
    const id = comment(peer.content, peer.annotations, "Alice");
    await eventually(() => s.server.journaled(DOC) >= 2);
    const cursor = s.server.journaled(DOC);
    await s.keep(peer.content, peer.annotations, cursor);
    expect(await countAwaiting(s.entry, s.env)).toBe(0);
    writeReply(
      peer.annotations,
      draftReply(peer.annotations, id, { author: "Bob", body: "No." }),
    );
    await eventually(() => s.server.journaled(DOC) > cursor);
    expect(await countAwaiting(s.entry, s.env)).toBe(1);
    peer.connection.close();
  });

  test("it writes nothing: neither its own operations nor its decisions (NT1)", async () => {
    const s = await setUp();
    const content = new LoroDoc();
    content.getText("content").insert(0, "Hello");
    content.commit();
    const annotations = new LoroDoc();
    comment(content, annotations, "Bob");
    const owner = await s.keep(content, annotations, 0);
    expect(await countAwaiting(s.entry, s.env)).toBe(1);
    expect(s.server.journaled(DOC)).toBe(0);
    // The copy is as it was, its owner still holding the lock.
    const kept = await peekLocalRecord({
      documentId: DOC,
      role: "edit",
      key: s.key,
      indexedDB: s.indexedDB,
    });
    expect(kept?.decisions.outbox).toHaveLength(1);
    owner.release();
  });

  test("nothing without a copy on the device, and no connection (NT2)", async () => {
    const s = await setUp();
    expect(await countAwaiting(s.entry, s.env)).toBeUndefined();
    expect(s.server.authentications).toBe(0);
  });

  test("nothing for a link refused, the connection closed (NT5)", async () => {
    const s = await setUp();
    await s.keep(new LoroDoc(), new LoroDoc(), 0);
    s.server.checkAuth = () => 4401;
    expect(await countAwaiting(s.entry, s.env)).toBeUndefined();
    const tried = s.server.authentications;
    await s.env.activity.settled();
    expect(s.server.authentications).toBe(tried);
  });

  test("nothing from a server that doesn't answer in time, the connection closed (NT5)", async () => {
    const s = await setUp();
    await s.keep(new LoroDoc(), new LoroDoc(), 0);
    // A socket that never opens.
    let closed = 0;
    const mute = {
      ...s.env,
      socketFactory: () => ({
        send: () => {},
        close: () => void closed++,
        onopen: null,
        onmessage: null,
        onclose: null,
      }),
    };
    const counting = countAwaiting(s.entry, mute);
    await eventually(() => s.timers.length === 1);
    s.timers[0]?.();
    expect(await counting).toBeUndefined();
    expect(closed).toBe(1);
  });

  test("nothing once stopped (NT4)", async () => {
    const s = await setUp();
    const content = new LoroDoc();
    const annotations = new LoroDoc();
    comment(content, annotations, "Bob");
    await s.keep(content, annotations, 0);
    expect(await countAwaiting(s.entry, s.env, () => true)).toBeUndefined();
    expect(s.server.authentications).toBe(0);
  });

  test("nothing for a link that doesn't read", async () => {
    const s = await setUp();
    expect(
      await countAwaiting({ ...s.entry, link: "not a link" }, s.env),
    ).toBeUndefined();
  });

  test("resumed from a copy, nothing of its own to send again (NT1)", () => {
    const own = [{ peer: "1", acked: 0 }];
    const adopted = [{ change: new Uint8Array([2]), ownBefore: [] }];
    expect(
      readOnlyResume({
        channels: [
          {
            channel: "content",
            snapshot: new Uint8Array(),
            cursor: 4,
            own,
            adopted,
          },
          {
            channel: "annotations",
            snapshot: new Uint8Array(),
            cursor: 7,
            own,
            adopted,
          },
        ],
        decisions: { cursor: 3, confirmed: [], outbox: [new Uint8Array([1])] },
      }),
    ).toEqual({
      channels: [
        { channel: "content", cursor: 4, own: [], adopted: [] },
        { channel: "annotations", cursor: 7, own: [], adopted: [] },
      ],
      decisions: { cursor: 3, outbox: [] },
    });
  });
});
