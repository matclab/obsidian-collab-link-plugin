// @vitest-environment jsdom
// The trace recorder (`?trace`, phase 4bis; phase 38g): each input with
// the state it found, each information as it comes, the UUIDs drawn and
// the errors the console alone would have seen.
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Snapshot, TRACE_VERSION, toBase64 } from "./format.js";
import { TraceRecorder } from "./recorder.js";
import { formatReport, summary } from "./report.js";

const state = (text: string): Snapshot => ({
  text,
  view: text,
  annotations: [],
  confirmed: 0,
});

const meta = {
  documentId: "doc",
  author: "Ada",
  peers: { content: "1", annotations: "2" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the trace recorder", () => {
  test("an input carries the state it found; the trace ends with the state now", () => {
    let now = "";
    const recorder = new TraceRecorder(meta, () => state(now));
    recorder.input({ kind: "edit", changes: [[0, "a"]], userEvent: "input" });
    now = "a";
    recorder.info({ kind: "published", channel: "content", bytes: "" });
    recorder.uuid("u-1");

    const trace = recorder.toTrace();
    expect(trace).toMatchObject({
      version: TRACE_VERSION,
      ...meta,
      uuids: ["u-1"],
      final: state("a"),
    });
    expect(trace.entries.map((entry) => entry.kind)).toEqual([
      "edit",
      "published",
    ]);
    expect(trace.entries[0]).toMatchObject({ before: state("") });
  });

  test("with the window's globals: the UUIDs drawn, and every error the console or the window sees", () => {
    const recorder = new TraceRecorder(meta, () => state(""));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = window.crypto.randomUUID;
    recorder.captureGlobals(window);
    try {
      const drawn = window.crypto.randomUUID();
      console.error("swallowed", { code: 7 });
      window.dispatchEvent(
        new ErrorEvent("error", { error: new Error("thrown") }),
      );
      const rejection = new Event("unhandledrejection");
      Object.assign(rejection, { reason: "refused" });
      window.dispatchEvent(rejection);

      const trace = recorder.toTrace();
      expect(trace.uuids).toEqual([drawn]);
      const messages = trace.entries.map((entry) =>
        entry.kind === "error" ? entry.message : "",
      );
      expect(messages[0]).toBe('swallowed {"code":7}');
      expect(messages[1]).toContain("thrown");
      expect(messages[2]).toBe("refused");
    } finally {
      window.crypto.randomUUID = before;
    }
  });
});

describe("the trace's report", () => {
  test("a timeline of every entry, the replay's findings inline", () => {
    const bytes = toBase64(new TextEncoder().encode("frame"));
    const record = toBase64(new TextEncoder().encode("accept"));
    const recorder = new TraceRecorder(meta, () => state(""));
    recorder.input({ kind: "import", channel: "content", bytes });
    recorder.input({
      kind: "importBatch",
      channel: "annotations",
      updates: [bytes, bytes],
    });
    recorder.input({ kind: "confirm", batch: [{ seq: 3, record }] });
    recorder.input({ kind: "edit", changes: [[0, "a"]], userEvent: "input" });
    recorder.input({
      kind: "create",
      type: "comment",
      from: 0,
      to: 1,
      extra: "",
      addAt: 1,
    });
    recorder.input({ kind: "propose", id: "s1", decision: "accept" });
    recorder.input({ kind: "resolve", id: "c1" });
    recorder.input({ kind: "reply", id: "c1", body: "yes" });
    recorder.info({ kind: "published", channel: "content", bytes });
    recorder.info({ kind: "error", message: "boom" });
    const report = {
      divergences: [{ index: 1, kind: "text", difference: "a ≠ b" }],
      violations: [{ index: 3, kind: "anchor", message: "out of range" }],
      browserErrors: [{ index: 9, message: "boom" }],
      replayErrors: ["replay threw"],
      finalDifference: "text",
    };

    const text = formatReport(recorder.toTrace(), report);
    for (const line of [
      "trace of Ada, document doc",
      "1 divergence(s), 1 violation(s), 1 browser error(s), 1 replay error(s), final state differs",
      "#0 +",
      "import content (5 bytes)",
      "import annotations, 2 updates at once",
      "!! DIVERGENCE before this entry — a ≠ b",
      "confirm seq 3: accept",
      'edit (input) [[0,"a"]]',
      "!! VIOLATION after — out of range",
      'create comment [0,1) at 1 ""',
      "propose accept s1",
      "resolve c1",
      'reply to c1: "yes"',
      "published on content: frame",
      "ERROR in the browser: boom",
      "FINAL STATE differs — text",
      "errors raised during the replay:",
      "replay threw",
    ]) {
      expect(text).toContain(line);
    }
  });

  test("a clean replay says so", () => {
    expect(
      summary({
        divergences: [],
        violations: [],
        browserErrors: [],
        replayErrors: [],
      }),
    ).toBe(
      "0 divergence(s), 0 violation(s), 0 browser error(s), 0 replay error(s), final state matches",
    );
  });
});
