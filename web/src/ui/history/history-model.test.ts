import { LoroDoc, type LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { suggestAddition } from "../../../lib/src/annotations/actions.js";
import { suggestionPeer } from "../../../lib/src/annotations/detached.js";
import { nameVersion, registerPeers } from "../../../lib/src/history/tables.js";
import { counter, resetCounters } from "../../perf/index.js";
import { HistoryModel } from "./history-model.js";

function type(doc: LoroDoc, at: number, insert: string): void {
  doc.setNextCommitTimestamp(at);
  const text = doc.getText("content");
  text.insert(text.length, insert);
  doc.commit();
}

function setUp() {
  const contentDoc = new LoroDoc();
  contentDoc.setPeerId(1n);
  contentDoc.setRecordTimestamp(true);
  contentDoc.setChangeMergeInterval(60);
  const annotationsDoc = new LoroDoc();
  annotationsDoc.setPeerId(1n);
  registerPeers(annotationsDoc, ["1"], "alice");
  return { contentDoc, annotationsDoc };
}

describe("HistoryModel", () => {
  test("groups and named versions, newest first", () => {
    const { contentDoc, annotationsDoc } = setUp();
    type(contentDoc, 1000, "draft");
    nameVersion(annotationsDoc, contentDoc.frontiers(), {
      name: "first draft",
      author: "alice",
      at: 1_100_000,
    });
    type(contentDoc, 2000, " final");
    const entries = new HistoryModel(contentDoc, annotationsDoc).entries();
    expect(
      entries.map((entry) =>
        entry.kind === "named" ? `named ${entry.name}` : `group ${entry.start}`,
      ),
    ).toEqual(["group 2000", "named first draft", "group 1000"]);
    expect(entries[0]).toMatchObject({ author: "alice", current: true });
    expect(entries[2]).toMatchObject({ current: false });
  });

  test("an accepted suggestion's change is its reviewer's", () => {
    const { contentDoc, annotationsDoc } = setUp();
    type(contentDoc, 1000, "hello");
    const reviewer = new LoroDoc();
    reviewer.import(contentDoc.export({ mode: "snapshot" }));
    const id = suggestAddition(reviewer, annotationsDoc, {
      at: 5,
      text: " world",
      author: "bob",
    });
    const change = annotationsDoc.getMap("annotations").get(id) as LoroMap;
    contentDoc.import(change.get("change") as Uint8Array);
    const [latest] = new HistoryModel(contentDoc, annotationsDoc).entries();
    expect(latest).toMatchObject({
      kind: "group",
      author: "bob",
      peers: [suggestionPeer(id).toString()],
    });
  });

  test("a restore shows its message", () => {
    const { contentDoc, annotationsDoc } = setUp();
    type(contentDoc, 1000, "a");
    contentDoc.setNextCommitTimestamp(2000);
    contentDoc.getText("content").insert(0, "b");
    contentDoc.commit({ message: "Restored from “v1”" });
    const [latest] = new HistoryModel(contentDoc, annotationsDoc).entries();
    expect(latest).toMatchObject({ messages: ["Restored from “v1”"] });
  });

  test("computed at most once per version of the two docs", () => {
    const { contentDoc, annotationsDoc } = setUp();
    type(contentDoc, 1000, "a");
    const model = new HistoryModel(contentDoc, annotationsDoc);
    resetCounters();
    model.entries();
    model.entries();
    expect(counter("history.list")).toBe(1);
    type(contentDoc, 1001, "b");
    model.entries();
    model.entries();
    expect(counter("history.list")).toBe(2);
  });
});
