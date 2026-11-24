import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { importHistory } from "./import-history.js";

describe("importHistory", () => {
  // A journal compacted with a shallow snapshot (before ADR-0017), then an
  // update from a peer offline since before it: Loro refuses that update,
  // and with it the whole batch it is in.
  test("a batch Loro refuses is imported entry by entry: only the culprit is skipped", () => {
    const a = new LoroDoc();
    a.setPeerId(1n);
    a.getText("t").insert(0, "hello");
    a.commit();
    const offline = new LoroDoc();
    offline.setPeerId(2n);
    offline.import(a.export({ mode: "update" }));
    const before = offline.oplogVersion();
    offline.getText("t").insert(0, "B");
    offline.commit();
    const stale = offline.export({ mode: "update", from: before });
    a.getText("t").insert(5, " world");
    a.commit();
    const shallow = a.export({
      mode: "shallow-snapshot",
      frontiers: a.oplogFrontiers(),
    });
    const c = new LoroDoc();
    c.setPeerId(3n);
    c.import(shallow);
    const at = c.oplogVersion();
    c.getText("t").insert(11, "!");
    c.commit();
    const fresh = c.export({ mode: "update", from: at });
    const doc = new LoroDoc();
    let invalid = 0;

    importHistory(doc, [shallow, stale, fresh], new Map(), () => invalid++);

    expect(doc.getText("t").toString()).toBe("hello world!");
    expect(invalid).toBe(1);
  });
});
