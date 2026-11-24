import { LoroDoc } from "loro-crdt";
import { describe, expect, test, vi } from "vitest";
import { nameVersion, registerPeers } from "../history/tables.js";
import { EDITOR_ORIGIN } from "../origins.js";
import { counter, resetCounters } from "../perf/index.js";
import { suggestAddition } from "./actions.js";
import { AnnotationIndex, computeAnnotationsView } from "./annotation-index.js";
import { DecisionLog, encodeProposal } from "./decisions.js";
import {
  createAnnotation,
  tryCreateAnnotation,
  updateStatus,
} from "./model.js";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function setUp(text = "hello world") {
  const contentDoc = new LoroDoc();
  contentDoc.setPeerId(1n);
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const annotationsDoc = new LoroDoc();
  annotationsDoc.setPeerId(1n);
  const log = new DecisionLog();
  const index = new AnnotationIndex(contentDoc, annotationsDoc, log);
  const comment = (start: number, end: number, body = "c") =>
    createAnnotation(contentDoc, annotationsDoc, {
      type: "comment",
      start,
      end,
      author: "alice",
      body,
    });
  return { contentDoc, annotationsDoc, log, index, comment };
}

/** A peer holding the same docs, to produce imports. */
function remoteOf(doc: LoroDoc): LoroDoc {
  const remote = new LoroDoc();
  remote.setPeerId(2n);
  remote.import(doc.export({ mode: "update" }));
  return remote;
}

describe("AnnotationIndex.current", () => {
  test("equals a fresh computation after every kind of change", () => {
    const { contentDoc, annotationsDoc, index, comment } = setUp();
    const fresh = () => computeAnnotationsView(contentDoc, annotationsDoc);
    expect(index.current()).toEqual(fresh());

    const id = comment(0, 7);
    expect(index.current()).toEqual(fresh());

    contentDoc.getText("content").insert(2, "XX"); // local, inside the range
    contentDoc.commit();
    expect(index.current().byId.get(id)?.range).toEqual({ start: 0, end: 9 });
    expect(index.current()).toEqual(fresh());

    const remote = remoteOf(contentDoc);
    remote.getText("content").delete(0, 4);
    remote.commit();
    contentDoc.import(remote.export({ mode: "update" }));
    expect(index.current()).toEqual(fresh());

    updateStatus(annotationsDoc, id, "resolved");
    expect(index.current().byId.get(id)?.status).toBe("resolved");
    expect(index.current()).toEqual(fresh());
  });

  test("lists annotations by creation time (not by id) and finds crossings among open ones only", () => {
    const { annotationsDoc, index, comment } = setUp();
    let now = 2000;
    vi.spyOn(Date, "now").mockImplementation(() => now--);
    const first = comment(0, 7, "first");
    const second = comment(5, 11, "second");
    vi.restoreAllMocks();
    expect(index.current().annotations.map((a) => a.id)).toEqual([
      second,
      first,
    ]);
    expect(index.current().conflicts).toHaveLength(1);

    updateStatus(annotationsDoc, first, "resolved");
    expect(index.current().conflicts).toEqual([]);
  });

  test("orders annotations created in the same millisecond by id, the same way every time", () => {
    const { index, comment } = setUp();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const ids = [comment(0, 1, "a"), comment(2, 3, "b"), comment(4, 5, "c")];
    vi.restoreAllMocks();

    expect(index.current().annotations.map((a) => a.id)).toEqual(
      [...ids].sort(),
    );
  });

  test("resolves the annotations once per version, however many readers ask", () => {
    const { index, comment } = setUp();
    comment(0, 5);
    resetCounters();

    index.current();
    index.current();
    index.current();

    expect(counter("annotations.resolveAll")).toBe(1);
  });
});

describe("AnnotationIndex.subscribe", () => {
  test("the editor's typing notifies no one; any other local write of the text does (a restore, phase 7b)", async () => {
    const { contentDoc, index, comment } = setUp();
    comment(0, 5);
    await tick();
    let calls = 0;
    index.subscribe(() => calls++);

    contentDoc.getText("content").insert(0, "typed ");
    contentDoc.commit({ origin: EDITOR_ORIGIN });
    await tick();
    expect(calls).toBe(0);

    contentDoc.getText("content").delete(0, 6);
    contentDoc.commit({ message: "Restored from “v1”" });
    await tick();
    expect(calls).toBe(1);
  });

  test("the history tables notify no one, and resolve nothing (phase 7b)", async () => {
    const { contentDoc, annotationsDoc, index, comment } = setUp();
    comment(0, 5);
    await tick();
    let calls = 0;
    index.subscribe(() => calls++);
    resetCounters();

    registerPeers(annotationsDoc, ["1"], "alice");
    nameVersion(annotationsDoc, contentDoc.frontiers(), {
      name: "v1",
      author: "a",
      at: 1,
    });
    const remote = remoteOf(annotationsDoc);
    registerPeers(remote, ["2"], "bob");
    annotationsDoc.import(remote.export({ mode: "update" }));
    await tick();
    expect(calls).toBe(0);
    expect(counter("annotations.resolveAll")).toBe(0);

    comment(6, 8); // an annotation still does
    await tick();
    expect(calls).toBe(1);
  });

  test("notifies once, in a microtask, for several synchronous changes", async () => {
    const { index, comment } = setUp();
    let calls = 0;
    index.subscribe(() => calls++);

    comment(0, 2);
    comment(3, 5);
    comment(6, 8);
    expect(calls).toBe(0);

    await tick();
    expect(calls).toBe(1);
  });

  test("notifies on an import of either doc and on a confirmed decision", async () => {
    const { contentDoc, annotationsDoc, log, index, comment } = setUp();
    const id = comment(0, 5);
    await tick();
    let calls = 0;
    index.subscribe(() => calls++);

    const remote = remoteOf(contentDoc);
    remote.getText("content").insert(0, "!");
    remote.commit();
    contentDoc.import(remote.export({ mode: "update" }));
    await tick();
    expect(calls).toBe(1);

    const remoteAnnotations = remoteOf(annotationsDoc);
    remoteAnnotations.getMap("annotations").set("other", "not an entry");
    remoteAnnotations.commit();
    annotationsDoc.import(remoteAnnotations.export({ mode: "update" }));
    await tick();
    expect(calls).toBe(2);

    log.add([
      {
        seq: 1,
        record: encodeProposal({
          proposalId: "p",
          annotationId: id,
          decision: "accept",
          author: "bob",
        }),
      },
    ]);
    await tick();
    expect(calls).toBe(3);
  });

  test("a local edit of the text neither notifies nor resolves anything", async () => {
    const { contentDoc, index, comment } = setUp();
    comment(0, 5);
    await tick();
    let calls = 0;
    index.subscribe(() => calls++);
    resetCounters();

    contentDoc.getText("content").insert(0, "typed");
    contentDoc.commit({ origin: "codemirror-editor" });
    await tick();

    expect(calls).toBe(0);
    expect(counter("cursor.resolve")).toBe(0);
  });

  test("writers run before readers, and readers see what they wrote, once", async () => {
    const { annotationsDoc, index, comment } = setUp();
    const id = comment(0, 5);
    await tick();
    const seen: string[] = [];
    index.subscribe(() => {
      seen.push(index.current().byId.get(id)?.status ?? "missing");
    });
    let wrote = false;
    index.subscribeWriter(() => {
      if (wrote) return;
      wrote = true;
      updateStatus(annotationsDoc, id, "resolved");
    });

    comment(6, 8);
    await tick();
    await tick();

    expect(seen).toEqual(["resolved"]);
  });

  test("stops notifying once unsubscribed", async () => {
    const { index, comment } = setUp();
    let calls = 0;
    const unsubscribe = index.subscribe(() => calls++);
    unsubscribe();
    comment(0, 5);
    await tick();
    expect(calls).toBe(0);
  });
});

describe("previews of pending suggestions (ADR-0018)", () => {
  test("the view holds, for each open addition or substitution, its text and where it would land", () => {
    const { contentDoc, annotationsDoc, index, comment } = setUp();
    const addition = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    const substitution = tryCreateAnnotation(contentDoc, annotationsDoc, {
      type: "substitution",
      start: 6,
      end: 11,
      author: "alice",
      replacement: "there",
    });
    if (!substitution.ok) throw new Error("unexpected conflict");
    comment(0, 5);

    const { previews } = index.current();
    expect(previews.get(addition)).toEqual({
      kind: "valid",
      text: " dear",
      at: 5,
    });
    expect(previews.get(substitution.id)).toEqual({
      kind: "valid",
      text: "there",
      at: 11,
    });
    expect(previews.size).toBe(2);
  });

  test("a decided suggestion has no preview", () => {
    const { contentDoc, annotationsDoc, index } = setUp();
    const addition = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    updateStatus(annotationsDoc, addition, "rejected");
    expect(index.current().previews.size).toBe(0);
  });

  test("a preview is decoded once, then follows the text: a remote edit decodes nothing", () => {
    const { contentDoc, annotationsDoc, index } = setUp();
    const id = suggestAddition(contentDoc, annotationsDoc, {
      at: 5,
      text: " dear",
      author: "alice",
    });
    expect(index.current().previews.get(id)).toMatchObject({ at: 5 });
    const remote = remoteOf(contentDoc);
    remote.getText("content").insert(0, ">> ");
    remote.commit();
    resetCounters();

    contentDoc.import(remote.export({ mode: "update" }));

    expect(index.current().previews.get(id)).toEqual({
      kind: "valid",
      text: " dear",
      at: 8,
    });
    expect(counter("detached.check")).toBe(0);
  });

  test("previews cost one check per open suggestion and per version, whoever asks", () => {
    const { contentDoc, annotationsDoc, index } = setUp();
    for (const at of [0, 5, 11]) {
      suggestAddition(contentDoc, annotationsDoc, {
        at,
        text: "x",
        author: "alice",
      });
    }
    resetCounters();
    index.current();
    index.current();
    expect(counter("detached.check")).toBe(3);
  });
});

// Phase 9, R3 (docs/security/review-9f.md): a Loro panic raised in a
// listener must reach whoever halts the page (analysis L4), not be logged
// and forgotten like an ordinary error.
describe("a Loro panic in a listener", () => {
  test("is handed to onTrap; an ordinary error is still logged", async () => {
    const contentDoc = new LoroDoc();
    const annotationsDoc = new LoroDoc();
    const traps: unknown[] = [];
    const index = new AnnotationIndex(contentDoc, annotationsDoc, undefined, {
      onTrap: (error) => traps.push(error),
    });
    const trap = new WebAssembly.RuntimeError("unreachable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    index.subscribe(() => {
      throw trap;
    });
    index.subscribe(() => {
      throw new Error("ordinary");
    });
    annotationsDoc.getMap("annotations").set("x", 1);
    annotationsDoc.commit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(traps).toEqual([trap]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    index.destroy();
  });
});
