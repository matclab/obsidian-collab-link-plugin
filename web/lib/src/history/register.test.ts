import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { registerOnFirstEdit } from "./register.js";
import { peerNames } from "./tables.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setUp(channels: ("content" | "annotations")[]) {
  const contentDoc = new LoroDoc();
  const annotationsDoc = new LoroDoc();
  const name = { current: "alice" };
  const registration = registerOnFirstEdit({
    contentDoc,
    annotationsDoc,
    channels,
    author: () => name.current,
  });
  const edit = async () => {
    contentDoc.getText("content").insert(0, "mine");
    contentDoc.commit();
    await tick();
  };
  return { contentDoc, annotationsDoc, registration, name, edit };
}

describe("registerOnFirstEdit", () => {
  test("opening writes nothing; an import writes nothing", async () => {
    const { contentDoc, annotationsDoc } = setUp(["content", "annotations"]);
    const other = new LoroDoc();
    other.getText("content").insert(0, "theirs");
    other.commit();
    contentDoc.import(other.export({ mode: "snapshot" }));
    await tick();
    expect(annotationsDoc.oplogVersion().length()).toBe(0);
  });

  test("the first local edit registers the page's peers, once", async () => {
    const { contentDoc, annotationsDoc } = setUp(["content", "annotations"]);
    contentDoc.getText("content").insert(0, "mine");
    contentDoc.commit();
    await tick();
    expect(peerNames(annotationsDoc)).toEqual(
      new Map([
        [contentDoc.peerIdStr, "alice"],
        [annotationsDoc.peerIdStr, "alice"],
      ]),
    );
    const after = annotationsDoc.version();
    contentDoc.getText("content").insert(0, "more ");
    contentDoc.commit();
    annotationsDoc.getMap("annotations").set("x", 1);
    annotationsDoc.commit();
    await tick();
    expect(peerNames(annotationsDoc).size).toBe(2);
    expect(annotationsDoc.version().get(annotationsDoc.peerIdStr)).toBe(
      (after.get(annotationsDoc.peerIdStr) ?? 0) + 1, // only the "x" edit
    );
  });

  test("only the channels the role publishes on (a reviewer: annotations)", async () => {
    const { contentDoc, annotationsDoc } = setUp(["annotations"]);
    annotationsDoc.getMap("annotations").set("x", 1);
    annotationsDoc.commit();
    await tick();
    expect([...peerNames(annotationsDoc).keys()]).toEqual([
      annotationsDoc.peerIdStr,
    ]);
    expect(contentDoc.peerIdStr).not.toBe(annotationsDoc.peerIdStr);
  });

  test("with no channel (a reader), never anything", async () => {
    const { contentDoc, annotationsDoc } = setUp([]);
    contentDoc.getText("content").insert(0, "local only");
    contentDoc.commit();
    await tick();
    expect(peerNames(annotationsDoc).size).toBe(0);
  });

  // Decision 9 of phase 7, validated with 7d: a renamed page's peers carry
  // the new name, and so do all its changes in the history.
  test("renamed before the first edit: the first edit registers the new name", async () => {
    const { annotationsDoc, registration, name, edit } = setUp(["content"]);
    name.current = "bob";
    registration.renamed();
    expect(annotationsDoc.oplogVersion().length()).toBe(0);

    await edit();

    expect([...peerNames(annotationsDoc).values()]).toEqual(["bob"]);
  });

  test("renamed after it: the page's peers are rewritten, once", async () => {
    const { contentDoc, annotationsDoc, registration, name, edit } = setUp([
      "content",
      "annotations",
    ]);
    await edit();
    name.current = "bob";

    registration.renamed();

    expect(peerNames(annotationsDoc)).toEqual(
      new Map([
        [contentDoc.peerIdStr, "bob"],
        [annotationsDoc.peerIdStr, "bob"],
      ]),
    );
    const version = annotationsDoc.version();
    registration.renamed();
    expect(annotationsDoc.version().compare(version)).toBe(0);
  });

  test("a reader's rename writes nothing", async () => {
    const { annotationsDoc, registration, name, edit } = setUp([]);
    await edit();
    name.current = "bob";
    registration.renamed();
    expect(annotationsDoc.oplogVersion().length()).toBe(0);
  });
});
