// Presence states against the specification's vectors
// (docs/protocol/03-document.md §3.9, docs/protocol/vectors.json).
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { fromHex, vectors } from "../test-support/vectors.js";
import { Presence } from "./presence.js";

describe("presence, as the vectors say", () => {
  test.each(
    vectors.document.presence as {
      why: string;
      plaintext: string;
      shown: boolean;
      anchor_resolved?: boolean;
    }[],
  )("D-31, D-32, D-37: $why", ({ plaintext, shown, anchor_resolved }) => {
    const doc = new LoroDoc();
    doc.getText("content").insert(0, "hello");
    doc.commit();
    const presence = new Presence({
      doc,
      name: () => "me",
      publish: () => {},
    });

    presence.receive(fromHex(plaintext));

    const others = presence.others();
    expect(others).toHaveLength(shown ? 1 : 0);
    if (anchor_resolved === false) {
      expect(others[0]?.anchor).toBeUndefined();
      doc.export({ mode: "snapshot" }); // still usable
    }
    presence.destroy();
  });
});
