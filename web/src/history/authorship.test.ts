import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { suggestAddition } from "../../lib/src/annotations/actions.js";
import { suggestionPeer } from "../../lib/src/annotations/detached.js";
import { registerPeers } from "../../lib/src/history/tables.js";
import { counter, resetCounters } from "../perf/index.js";
import {
  authorRuns,
  authors,
  insertionAt,
  personOf,
  personOrder,
} from "./authorship.js";

function page(peer: bigint): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  doc.setRecordTimestamp(true);
  return doc;
}

const sync = (from: LoroDoc, to: LoroDoc) =>
  to.import(from.export({ mode: "update", from: to.oplogVersion() }));

/** "aXYbc": peer 1 typed "abc" at 1000, peer 2 "XY" after the "a" at 2000. */
function twoPeers() {
  const one = page(1n);
  one.setNextCommitTimestamp(1000);
  one.getText("content").insert(0, "abc");
  one.commit();
  const two = page(2n);
  sync(one, two);
  two.setNextCommitTimestamp(2000);
  two.getText("content").insert(1, "XY");
  two.commit();
  sync(two, one);
  return one;
}

describe("authorRuns", () => {
  test("the stretches of a range, one per peer in a row", () => {
    const text = twoPeers().getText("content");
    expect(authorRuns(text, 0, 5)).toEqual([
      { from: 0, to: 1, peer: "1" },
      { from: 1, to: 3, peer: "2" },
      { from: 3, to: 5, peer: "1" },
    ]);
    expect(authorRuns(text, 2, 4)).toEqual([
      { from: 2, to: 3, peer: "2" },
      { from: 3, to: 4, peer: "1" },
    ]);
  });

  test("an empty range, or one past the end, has none", () => {
    const text = twoPeers().getText("content");
    expect(authorRuns(text, 2, 2)).toEqual([]);
    expect(authorRuns(text, 4, 9)).toEqual([{ from: 4, to: 5, peer: "1" }]);
  });

  test("never cuts a character outside the basic plane in two", () => {
    const one = page(1n);
    one.getText("content").insert(0, "ab");
    one.commit();
    const two = page(2n);
    sync(one, two);
    two.getText("content").insert(1, "😀");
    two.commit();
    const text = two.getText("content");
    expect(authorRuns(text, 0, 4)).toEqual([
      { from: 0, to: 1, peer: "1" },
      { from: 1, to: 3, peer: "2" },
      { from: 3, to: 4, peer: "1" },
    ]);
    // From the middle of the pair: its peer still.
    expect(authorRuns(text, 2, 4)).toEqual([
      { from: 2, to: 3, peer: "2" },
      { from: 3, to: 4, peer: "1" },
    ]);
  });

  test("reads each character once, and no other", () => {
    const text = twoPeers().getText("content");
    resetCounters();
    authorRuns(text, 1, 4);
    expect(counter("authorship.char")).toBe(3);
  });
});

describe("insertionAt", () => {
  test("the peer and date of a character's insertion", () => {
    const doc = twoPeers();
    expect(insertionAt(doc, 0)).toEqual({ peer: "1", at: 1000 });
    expect(insertionAt(doc, 2)).toEqual({ peer: "2", at: 2000 });
    expect(insertionAt(doc, 5)).toBeUndefined();
  });

  test("no date for a change recorded without one", () => {
    const doc = new LoroDoc();
    doc.setPeerId(3n);
    doc.getText("content").insert(0, "a");
    doc.commit();
    expect(insertionAt(doc, 0)).toEqual({ peer: "3", at: undefined });
  });

  test("a shallow doc knows the peer, not the date", () => {
    const doc = twoPeers();
    const shallow = new LoroDoc();
    shallow.import(
      doc.export({ mode: "shallow-snapshot", frontiers: doc.frontiers() }),
    );
    expect(insertionAt(shallow, 0)).toEqual({ peer: "1", at: undefined });
  });
});

describe("authors", () => {
  test("the registered peers, and a suggestion's peer as its author", () => {
    const content = twoPeers();
    const annotationsDoc = new LoroDoc();
    registerPeers(annotationsDoc, ["1"], "alice");
    const reviewer = new LoroDoc();
    reviewer.import(content.export({ mode: "snapshot" }));
    const id = suggestAddition(reviewer, annotationsDoc, {
      at: 1,
      text: "!",
      author: "bob",
    });
    const names = authors(annotationsDoc);
    expect(names.get("1")).toBe("alice");
    expect(names.get(suggestionPeer(id).toString())).toBe("bob");
    expect(names.has("2")).toBe(false);
  });
});

describe("personOf", () => {
  const names = new Map([
    ["1", "alice"],
    ["4", "alice"],
    ["2", "bob"],
  ]);

  test("the peers of one name are one person", () => {
    expect(personOf("1", names)).toEqual(personOf("4", names));
    expect(personOf("1", names)).toEqual({ key: "@alice", name: "alice" });
    expect(personOf("2", names).key).not.toBe(personOf("1", names).key);
  });

  test("a peer no name is known for is unknown", () => {
    expect(personOf("9", names)).toEqual({ key: "?", name: undefined });
    expect(personOf(undefined, names)).toEqual({ key: "?", name: undefined });
  });
});

describe("personOrder", () => {
  test("by each person's first change, unknown left out", () => {
    const doc = twoPeers(); // peer 1 first, then peer 2
    const three = page(3n);
    sync(doc, three);
    three.getText("content").insert(0, "z");
    three.commit();
    sync(three, doc);
    expect(
      personOrder(
        doc,
        new Map([
          ["2", "bob"],
          ["1", "alice"],
        ]),
      ),
    ).toEqual(["@alice", "@bob"]);
  });

  test("a person's first peer places them", () => {
    const doc = twoPeers();
    const three = page(3n);
    sync(doc, three);
    three.getText("content").insert(0, "z");
    three.commit();
    sync(three, doc);
    // carol wrote with peer 3 last, and with peer 1 first.
    const names = new Map([
      ["1", "carol"],
      ["2", "bob"],
      ["3", "carol"],
    ]);
    expect(personOrder(doc, names)).toEqual(["@carol", "@bob"]);
  });

  test("a person who comes later takes the next place", () => {
    const doc = twoPeers();
    const names = new Map([
      ["1", "alice"],
      ["2", "bob"],
      ["3", "carol"],
    ]);
    const before = personOrder(doc, names);
    const three = page(3n);
    sync(doc, three);
    three.getText("content").insert(0, "z");
    three.commit();
    sync(three, doc);
    expect(personOrder(doc, names)).toEqual([...before, "@carol"]);
  });

  test("by Lamport time, not by peer", () => {
    const nine = page(9n);
    nine.getText("content").insert(0, "a");
    nine.commit();
    const two = page(2n);
    sync(nine, two);
    two.getText("content").insert(1, "b");
    two.commit();
    const names = new Map([
      ["2", "bob"],
      ["9", "alice"],
    ]);
    expect(personOrder(two, names)).toEqual(["@alice", "@bob"]);
  });

  test("one reading per computation", () => {
    const doc = twoPeers();
    resetCounters();
    personOrder(doc, new Map([["1", "alice"]]));
    expect(counter("authorship.order")).toBe(1);
  });
});
