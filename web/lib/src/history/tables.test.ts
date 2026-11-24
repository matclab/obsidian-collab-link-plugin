import { LoroDoc, LoroMap } from "loro-crdt";
import { describe, expect, test } from "vitest";
import {
  deleteVersion,
  listVersions,
  nameVersion,
  peerNames,
  registerPeers,
} from "./tables.js";

function typed(text: string): LoroDoc {
  const doc = new LoroDoc();
  doc.getText("content").insert(0, text);
  doc.commit();
  return doc;
}

describe("peers table", () => {
  test("registers the page's peers under a pseudonym", () => {
    const annotations = new LoroDoc();
    registerPeers(annotations, ["12", "34"], "alice");
    expect(peerNames(annotations)).toEqual(
      new Map([
        ["12", "alice"],
        ["34", "alice"],
      ]),
    );
  });

  test("registering again under the same name writes nothing", () => {
    const annotations = new LoroDoc();
    registerPeers(annotations, ["12"], "alice");
    const before = annotations.version();
    registerPeers(annotations, ["12"], "alice");
    expect(annotations.version().compare(before)).toBe(0);
  });

  test("a new name replaces the old one (pseudonym changed)", () => {
    const annotations = new LoroDoc();
    registerPeers(annotations, ["12"], "alice");
    registerPeers(annotations, ["12"], "alicia");
    expect(peerNames(annotations).get("12")).toBe("alicia");
  });

  test("entries a peer wrote badly are ignored (anyone with the key may)", () => {
    const annotations = new LoroDoc();
    const peers = annotations.getMap("peers");
    peers.set("not-a-peer", "mallory");
    peers.set("56", 42);
    peers.set("78", "x".repeat(1000));
    peers.set("90", "bob");
    annotations.commit();
    expect(peerNames(annotations)).toEqual(new Map([["90", "bob"]]));
  });
});

describe("versions table", () => {
  test("names the current version of the text, lists it, deletes it", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    const id = nameVersion(annotations, content.frontiers(), {
      name: "  first draft ",
      author: "alice",
      at: 1_700_000_000_000,
    });
    expect(listVersions(annotations, content)).toEqual([
      {
        id,
        name: "first draft",
        author: "alice",
        at: 1_700_000_000_000,
        frontiers: content.frontiers(),
        available: true,
      },
    ]);
    deleteVersion(annotations, id);
    expect(listVersions(annotations, content)).toEqual([]);
  });

  test("a version whose text hasn't arrived is listed as not available", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    nameVersion(annotations, content.frontiers(), {
      name: "v1",
      author: "a",
      at: 1,
    });
    const elsewhere = new LoroDoc();
    elsewhere.import(annotations.export({ mode: "snapshot" }));
    const [version] = listVersions(elsewhere, new LoroDoc());
    expect(version?.available).toBe(false);
  });

  test("a name is required, and bounded", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    const at = 1;
    expect(() =>
      nameVersion(annotations, content.frontiers(), {
        name: "  ",
        author: "a",
        at,
      }),
    ).toThrow();
    expect(() =>
      nameVersion(annotations, content.frontiers(), {
        name: "x".repeat(201),
        author: "a",
        at,
      }),
    ).toThrow();
  });

  test("listed by date, then id", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    nameVersion(annotations, content.frontiers(), {
      name: "later",
      author: "a",
      at: 2,
    });
    nameVersion(annotations, content.frontiers(), {
      name: "earlier",
      author: "a",
      at: 1,
    });
    expect(listVersions(annotations, content).map((v) => v.name)).toEqual([
      "earlier",
      "later",
    ]);
  });

  test("entries a peer wrote badly are ignored", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    const versions = annotations.getMap("versions");
    versions.set("plain", "not a map");
    const noName = versions.setContainer("no-name", new LoroMap());
    noName.set("author", "a");
    noName.set("at", 1);
    noName.set("frontiers", [{ peer: "1", counter: 0 }]);
    const badFrontiers = versions.setContainer("bad", new LoroMap());
    badFrontiers.set("name", "v");
    badFrontiers.set("author", "a");
    badFrontiers.set("at", 1);
    badFrontiers.set("frontiers", [{ peer: "x", counter: -1 }]);
    annotations.commit();
    expect(listVersions(annotations, content)).toEqual([]);
  });

  test("a peer beyond 64 bits is ignored, not thrown on (9c.3, C9)", () => {
    const content = typed("hello");
    const annotations = new LoroDoc();
    const versions = annotations.getMap("versions");
    for (const peer of ["18446744073709551616", "9".repeat(30)]) {
      const entry = versions.setContainer(peer, new LoroMap());
      entry.set("name", "v");
      entry.set("author", "a");
      entry.set("at", 1);
      entry.set("frontiers", [{ peer, counter: 0 }]);
    }
    const highest = versions.setContainer("highest", new LoroMap());
    highest.set("name", "v");
    highest.set("author", "a");
    highest.set("at", 1);
    highest.set("frontiers", [{ peer: "18446744073709551615", counter: 0 }]);
    annotations.getMap("peers").set("18446744073709551616", "mallory");
    annotations.commit();
    expect(listVersions(annotations, content).map((v) => v.id)).toEqual([
      "highest",
    ]);
    expect(peerNames(annotations)).toEqual(new Map());
  });

  test("two peers naming and deleting concurrently converge", () => {
    const content = typed("hello");
    const a = new LoroDoc();
    const b = new LoroDoc();
    const kept = nameVersion(a, content.frontiers(), {
      name: "kept",
      author: "a",
      at: 1,
    });
    const gone = nameVersion(a, content.frontiers(), {
      name: "gone",
      author: "a",
      at: 2,
    });
    b.import(a.export({ mode: "snapshot" }));
    deleteVersion(a, gone);
    nameVersion(b, content.frontiers(), { name: "b's", author: "b", at: 3 });
    a.import(b.export({ mode: "update", from: a.oplogVersion() }));
    b.import(a.export({ mode: "update", from: b.oplogVersion() }));
    expect(listVersions(a, content)).toEqual(listVersions(b, content));
    expect(listVersions(a, content).map((v) => v.id)).toContain(kept);
    expect(listVersions(a, content).map((v) => v.name)).toEqual([
      "kept",
      "b's",
    ]);
  });
});
