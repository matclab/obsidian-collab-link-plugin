import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { groupVersions } from "./versions.js";

/** Commits `insert` at the end of `doc`'s text, dated `at` (seconds). */
function type(doc: LoroDoc, at: number, insert: string): void {
  doc.setNextCommitTimestamp(at);
  const text = doc.getText("content");
  text.insert(text.length, insert);
  doc.commit();
}

function page(peer: bigint): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  doc.setRecordTimestamp(true);
  doc.setChangeMergeInterval(60);
  return doc;
}

const names = new Map([
  ["1", "alice"],
  ["2", "bob"],
  ["3", "alice"], // alice again, from another page
]);
const authorOf = (peer: string) => names.get(peer);

describe("groupVersions", () => {
  test("cuts at a pause of more than five minutes", () => {
    const doc = page(1n);
    type(doc, 1000, "a");
    type(doc, 1100, "b");
    type(doc, 1100 + 301, "c"); // after a pause
    const groups = groupVersions(doc, authorOf);
    expect(groups.map((g) => [g.author, g.start, g.end])).toEqual([
      ["alice", 1000, 1100],
      ["alice", 1401, 1401],
    ]);
    expect(groups.at(-1)?.frontiers).toEqual(doc.frontiers());
  });

  test("cuts when the author changes, and joins pages of the same pseudonym", () => {
    const alice = page(1n);
    type(alice, 1000, "a");
    const bob = page(2n);
    bob.import(alice.export({ mode: "snapshot" }));
    type(bob, 1010, "b");
    const alice2 = page(3n);
    alice2.import(bob.export({ mode: "snapshot" }));
    type(alice2, 1020, "c");
    type(alice2, 1030, "d");
    const groups = groupVersions(alice2, authorOf);
    expect(groups.map((g) => [g.author, g.changes.length])).toEqual([
      ["alice", 1],
      ["bob", 1],
      ["alice", 1], // 1020 and 1030 merged into one change
    ]);
  });

  test("a peer no one registered: its own group, with no author", () => {
    const doc = page(9n);
    type(doc, 1000, "a");
    const [group] = groupVersions(doc, authorOf);
    expect(group?.author).toBeUndefined();
    expect(group?.peers).toEqual(["9"]);
  });

  test("concurrent work is ordered by time, never before what it depends on", () => {
    const alice = page(1n);
    type(alice, 1000, "a");
    const bob = page(2n);
    bob.import(alice.export({ mode: "snapshot" }));
    type(alice, 2000, "late");
    type(bob, 1500, "offline"); // concurrent, earlier by the clock
    alice.import(bob.export({ mode: "update", from: alice.oplogVersion() }));
    const groups = groupVersions(alice, authorOf);
    expect(groups.map((g) => [g.author, g.start])).toEqual([
      ["alice", 1000],
      ["bob", 1500],
      ["alice", 2000],
    ]);
    // A clock behind can't put a change before what it depends on: Loro
    // dates it no earlier than its dependencies.
    const late = page(4n);
    late.import(alice.export({ mode: "snapshot" }));
    type(late, 10, "back in time");
    const last = groupVersions(late, authorOf).at(-1);
    expect(last?.peers).toEqual(["4"]);
    expect(last?.start).toBe(2000);
  });

  test("an empty document has no version", () => {
    expect(groupVersions(page(1n), authorOf)).toEqual([]);
  });
});
