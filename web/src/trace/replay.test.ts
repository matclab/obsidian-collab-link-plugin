// @vitest-environment jsdom
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AnnotationType,
  listAnnotations,
} from "../../lib/src/annotations/index.js";
import { type WiredClient, wireClient } from "../app/wire-client.js";
import type { Trace } from "./format.js";
import type { TraceRecorder } from "./recorder.js";
import { replayTrace } from "./replay.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// UUIDs go to the recorder of whichever client is acting, as
// `captureGlobals` does in a page (one client per page).
let acting: TraceRecorder | undefined;
const realRandomUUID = crypto.randomUUID.bind(crypto);
beforeEach(() => {
  crypto.randomUUID = () => {
    const value = realRandomUUID();
    acting?.uuid(value);
    return value;
  };
});
afterEach(() => {
  crypto.randomUUID = realRandomUUID;
});

interface Peer {
  client: WiredClient;
  recorder: TraceRecorder;
  contentDoc: LoroDoc;
  annotationsDoc: LoroDoc;
  panel: Element;
  outbox: Uint8Array[];
  updates: { channel: "content" | "annotations"; bytes: Uint8Array }[];
  confirmed: number;
}

function recordedPeer(author: string): Peer {
  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  const panel = document.createElement("div");
  const outbox: Uint8Array[] = [];
  const client = wireClient({
    contentDoc,
    annotationsDoc,
    editorParent: document.createElement("div"),
    panelParent: panel,
    author: () => author,
    documentId: "doc",
    publishDecision: (record) => outbox.push(record),
    trace: true,
  });
  const updates: Peer["updates"] = [];
  contentDoc.subscribeLocalUpdates((bytes) =>
    updates.push({ channel: "content", bytes }),
  );
  annotationsDoc.subscribeLocalUpdates((bytes) =>
    updates.push({ channel: "annotations", bytes }),
  );
  if (!client.recorder) throw new Error("tracing is on");
  return {
    client,
    recorder: client.recorder,
    contentDoc,
    annotationsDoc,
    panel,
    outbox,
    updates,
    confirmed: 0,
  };
}

/** A two-peer network with a decisions journal, delivering the way the
 * transport does: `imported` right before `import`. */
function network(a: Peer, b: Peer) {
  const delivered = new Map<Peer, number>([
    [a, 0],
    [b, 0],
  ]);
  const journal: Uint8Array[] = [];
  return {
    async deliver(from: Peer, to: Peer) {
      const start = delivered.get(from) ?? 0;
      for (const { channel, bytes } of from.updates.slice(start)) {
        to.client.imported(channel, [bytes]);
        (channel === "content" ? to.contentDoc : to.annotationsDoc).import(
          bytes,
        );
        await tick();
      }
      delivered.set(from, from.updates.length);
    },
    journal(peer: Peer) {
      journal.push(...peer.outbox.splice(0));
    },
    async confirm(peer: Peer) {
      const batch = journal
        .slice(peer.confirmed)
        .map((record, i) => ({ seq: peer.confirmed + i + 1, record }));
      if (batch.length === 0) return;
      peer.confirmed = journal.length;
      peer.client.confirm(batch);
      await tick();
    },
  };
}

async function type(peer: Peer, at: number, insert: string) {
  acting = peer.recorder;
  peer.client.editor.view.dispatch({
    changes: { from: at, insert },
    userEvent: "input.type",
  });
  await tick();
}

async function create(
  peer: Peer,
  type: string,
  from: number,
  to: number,
  extra = "",
  at?: number,
) {
  acting = peer.recorder;
  peer.client.editor.view.dispatch({ selection: { anchor: from, head: to } });
  peer.client.panel.create(type as AnnotationType, extra, "", at);
  await tick();
}

async function click(peer: Peer, id: string, action: string) {
  acting = peer.recorder;
  const button = peer.panel.querySelector<HTMLButtonElement>(
    `.annotation-item[data-id="${id}"] button[data-action="${action}"]`,
  );
  if (!button) throw new Error(`no ${action} button for ${id}`);
  button.click();
  await tick();
}

const idOf = (peer: Peer, type: string) =>
  listAnnotations(peer.contentDoc, peer.annotationsDoc).find(
    (a) => a.type === type,
  )?.id as string;

/** The scenario reported from a manual test (A: addition, then deletion;
 * B: substitution; A accepts the deletion), plus concurrent decisions on
 * the addition. Returns both traces, through JSON like a download. */
async function recordScenario(): Promise<[Trace, Trace]> {
  const a = recordedPeer("A");
  const b = recordedPeer("B");
  const net = network(a, b);
  await type(a, 0, "one two three four five");
  await net.deliver(a, b);
  // Placed by the toolbar, away from the caret (phase 24).
  await create(a, "addition", 0, 0, " and", 3);
  await create(a, "deletion", 8, 12);
  await net.deliver(a, b);
  await create(b, "substitution", 18, 22, "FOUR");
  await net.deliver(b, a);
  await click(a, idOf(a, "deletion"), "accept");
  await click(a, idOf(a, "addition"), "accept");
  await click(b, idOf(b, "addition"), "reject");
  net.journal(b);
  net.journal(a);
  await net.confirm(a);
  await net.confirm(b);
  await net.deliver(a, b);
  await net.deliver(b, a);
  await type(b, 0, "> ");
  await net.deliver(b, a);
  acting = undefined;
  return [
    JSON.parse(JSON.stringify(a.recorder.toTrace())),
    JSON.parse(JSON.stringify(b.recorder.toTrace())),
  ];
}

describe("scenario traces", () => {
  test("record every kind of input a client receives or performs", async () => {
    const [traceA] = await recordScenario();
    const kinds = new Set(traceA.entries.map((entry) => entry.kind));
    for (const kind of ["edit", "create", "propose", "import", "confirm"]) {
      expect(kinds).toContain(kind);
    }
    expect(traceA.uuids.length).toBeGreaterThan(0);
  });

  test("replaying each client's trace reproduces its recorded states exactly", async () => {
    const traces = await recordScenario();
    for (const trace of traces) {
      const report = await replayTrace(trace);
      expect(report).toEqual({
        divergences: [],
        violations: [],
        browserErrors: [],
        replayErrors: [],
      });
    }
  });

  test("the replay points at the first entry whose recorded state it doesn't reach", async () => {
    const [trace] = await recordScenario();
    const index = trace.entries.findIndex((entry) => entry.kind === "propose");
    const entry = trace.entries[index];
    if (!entry || !("before" in entry)) throw new Error("no propose entry");
    entry.before.text = "not what the browser had";

    const report = await replayTrace(trace);

    expect(report.divergences).toEqual([
      expect.objectContaining({ index, kind: "propose" }),
    ]);
  });

  test("errors the browser recorded are reported with their position", async () => {
    const [trace] = await recordScenario();
    trace.entries.splice(2, 0, { kind: "error", message: "boom", at: 0 });

    const report = await replayTrace(trace);

    expect(report.browserErrors).toEqual([{ index: 2, message: "boom" }]);
  });
});
