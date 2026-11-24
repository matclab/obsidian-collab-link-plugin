import { ChangeSet } from "@codemirror/state";
import { LoroDoc } from "loro-crdt";
import {
  type AnnotationType,
  importHistory,
  listAnnotations,
} from "../../lib/src/index.js";
import { type WiredClient, wireClient } from "../app/wire-client.js";
import {
  type InputEvent,
  TRACE_VERSION,
  type Trace,
  fromBase64,
  isInput,
} from "./format.js";
import { snapshotDifference, takeSnapshot } from "./snapshot.js";

export interface ReplayReport {
  /** Entries whose recorded `before` state the replay didn't reach: the
   * browser and the replay disagree on the effect of what came earlier. */
  divergences: { index: number; kind: string; difference: string }[];
  /** Invariants broken by the replay itself, after an entry. */
  violations: { index: number; kind: string; message: string }[];
  /** Errors the browser recorded, and errors raised during the replay. */
  browserErrors: { index: number; message: string }[];
  replayErrors: string[];
  /** How the final state differs from the one downloaded, if at all. */
  finalDifference?: string;
}

/** Replays one client's trace (`format.ts`) through the page's own wiring
 * (`wireClient`), in a DOM (jsdom in tests): the recorded inputs, in
 * order, with the same Loro peer ids and UUIDs, each followed by a
 * macrotask so effects scheduled in microtasks run as in the browser. */
export async function replayTrace(trace: Trace): Promise<ReplayReport> {
  const report: ReplayReport = {
    divergences: [],
    violations: [],
    browserErrors: [],
    replayErrors: [],
  };
  if (trace.version !== TRACE_VERSION) {
    report.replayErrors.push(
      `trace version ${trace.version}, this replay reads ${TRACE_VERSION}`,
    );
    return report;
  }
  const uuids = [...trace.uuids];
  const randomUUID = crypto.randomUUID;
  crypto.randomUUID = () => {
    const next = uuids.shift();
    if (!next) throw new Error("the replay drew more UUIDs than recorded");
    return next as ReturnType<typeof randomUUID>;
  };
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    report.replayErrors.push(args.map(String).join(" "));
  };
  const onRejection = (reason: unknown) => {
    report.replayErrors.push(
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason),
    );
  };
  process.on("unhandledRejection", onRejection);

  try {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();
    contentDoc.setPeerId(BigInt(trace.peers.content));
    annotationsDoc.setPeerId(BigInt(trace.peers.annotations));
    const panelParent = document.createElement("div");
    const client = wireClient({
      contentDoc,
      annotationsDoc,
      editorParent: document.createElement("div"),
      panelParent,
      author: () => trace.author,
      documentId: trace.documentId,
      publishDecision: () => {},
    });
    let confirmed = 0;
    const snapshot = () =>
      takeSnapshot(contentDoc, annotationsDoc, client.editor.view, confirmed);

    for (const [index, entry] of trace.entries.entries()) {
      if (!isInput(entry)) {
        if (entry.kind === "error") {
          report.browserErrors.push({ index, message: entry.message });
        }
        continue;
      }
      const difference = snapshotDifference(entry.before, snapshot());
      if (difference) {
        report.divergences.push({ index, kind: entry.kind, difference });
      }
      const problem = apply(entry, client, panelParent, {
        contentDoc,
        annotationsDoc,
      });
      if (problem)
        report.violations.push({ index, kind: entry.kind, message: problem });
      if (entry.kind === "confirm") confirmed += entry.batch.length;
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const message of checkInvariants(
        client,
        contentDoc,
        annotationsDoc,
      )) {
        report.violations.push({ index, kind: entry.kind, message });
      }
    }
    const finalDifference = snapshotDifference(trace.final, snapshot());
    if (finalDifference) report.finalDifference = finalDifference;
  } finally {
    crypto.randomUUID = randomUUID;
    console.error = consoleError;
    process.off("unhandledRejection", onRejection);
  }
  return report;
}

/** Applies one input; returns a problem when the UI didn't offer what the
 * user did (the replayed page differs from the recorded one). */
function apply(
  entry: InputEvent,
  client: WiredClient,
  panel: Element,
  docs: { contentDoc: LoroDoc; annotationsDoc: LoroDoc },
): string | undefined {
  const view = client.editor.view;
  switch (entry.kind) {
    case "import": {
      const doc =
        entry.channel === "content" ? docs.contentDoc : docs.annotationsDoc;
      doc.import(fromBase64(entry.bytes));
      return undefined;
    }
    case "importBatch": {
      const doc =
        entry.channel === "content" ? docs.contentDoc : docs.annotationsDoc;
      importHistory(doc, entry.updates.map(fromBase64));
      return undefined;
    }
    case "confirm":
      client.confirm(
        entry.batch.map(({ seq, record }) => ({
          seq,
          record: fromBase64(record),
        })),
      );
      return undefined;
    case "edit":
      view.dispatch({
        changes: ChangeSet.fromJSON(entry.changes),
        userEvent: entry.userEvent,
      });
      return undefined;
    case "create": {
      // The interface's own action: what the
      // selection toolbar calls. A refusal is the replayed page's answer,
      // as it was the recorded one's.
      view.dispatch({ selection: { anchor: entry.from, head: entry.to } });
      client.panel.create(
        entry.type as AnnotationType,
        entry.extra,
        entry.note ?? "",
        entry.addAt,
      );
      return undefined;
    }
    case "reply":
      client.panel.reply(entry.id, entry.body);
      return undefined;
    case "propose":
    case "resolve": {
      const action = entry.kind === "propose" ? entry.decision : "resolve";
      const button = panel.querySelector<HTMLButtonElement>(
        `.annotation-item[data-id="${entry.id}"] button[data-action="${action}"]`,
      );
      if (!button) return `no "${action}" button for ${entry.id}`;
      button.click();
      return undefined;
    }
  }
}

function checkInvariants(
  client: WiredClient,
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
): string[] {
  const problems: string[] = [];
  const text = contentDoc.getText("content").toString();
  const shown = client.editor.view.state.doc.toString();
  if (text !== shown) {
    problems.push(
      `the editor shows ${JSON.stringify(shown)} but Loro holds ${JSON.stringify(text)}`,
    );
  }
  for (const a of listAnnotations(contentDoc, annotationsDoc)) {
    if (a.type === "comment" || a.status === "open") continue;
    // Written by another peer, the status may arrive before this client
    // confirms the decision itself: only a contradiction is a problem.
    const winner = client.log.winner(a.id);
    if (!winner) continue;
    const expected = winner.decision === "accept" ? "accepted" : "rejected";
    if (a.status !== expected) {
      problems.push(
        `${a.type} ${a.id} is ${a.status}, the confirmed journal says ${expected}`,
      );
    }
  }
  return problems;
}
