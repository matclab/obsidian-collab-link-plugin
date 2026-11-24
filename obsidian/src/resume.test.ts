// "Resume this change" (docs/phase-14-plugin-obsidian.md, decisions 4 and
// 22; analysis 14e): the file's text replayed on the version it changed,
// under a peer drawn from what is resumed. Nothing the document received
// since is undone (ME3, OI1); without concurrency, the text is the file's;
// the same change resumed twice, on one device or two, enters once (ME4).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { resumeChange, resumePeer } from "./resume.js";

const textOf = (doc: LoroDoc) => doc.getText("content").toString();

/** A few edits of `text`, at drawn places, with letters of `alphabet`. */
function edited(tc: hegel.TestCase, text: string, alphabet: string[]): string {
  let next = text;
  const edits = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
  for (let i = 0; i < edits; i++) {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: next.length }));
    if (next.length > 0 && tc.draw(gs.booleans())) {
      const end = tc.draw(gs.integers({ minValue: at, maxValue: next.length }));
      next = next.slice(0, at) + next.slice(end);
    } else {
      next =
        next.slice(0, at) + tc.draw(gs.sampledFrom(alphabet)) + next.slice(at);
    }
  }
  return next;
}

function typeInto(doc: LoroDoc, text: string): void {
  doc.getText("content").update(text);
  doc.commit();
}

async function resume(
  doc: LoroDoc,
  base: ReturnType<LoroDoc["frontiers"]>,
  text: string,
) {
  const peer = await resumePeer("doc", base, text);
  const change = resumeChange(doc, base, text, peer);
  doc.import(change);
  return change;
}

describe("resuming a change from outside", () => {
  test("undoes nothing received since its base; without concurrency, the text is the file's", async () => {
    await hegel.testAsync(
      async (tc) => {
        const doc = new LoroDoc();
        doc.setPeerId(1n);
        typeInto(doc, edited(tc, "", ["a", "b", "\n", "é"]));
        const base = doc.frontiers();
        const before = textOf(doc);
        // The file changed outside, from the base.
        const file = edited(tc, before, ["x", "y", "\n"]);
        // Meanwhile, maybe, another device's typing: marked "§".
        const other = new LoroDoc();
        other.setPeerId(2n);
        other.import(doc.export({ mode: "snapshot" }));
        const concurrent = tc.draw(gs.booleans());
        if (concurrent) {
          typeInto(other, edited(tc, before, ["§"]));
          doc.import(other.export({ mode: "update" }));
        }
        const held = doc.oplogVersion();
        const marks = [...textOf(doc)].filter((c) => c === "§").length;

        await resume(doc, base, file);

        // ME3, OI1: every operation still there, none of "§" removed.
        expect(doc.oplogVersion().compare(held)).toBeGreaterThanOrEqual(0);
        expect([...textOf(doc)].filter((c) => c === "§").length).toBe(marks);
        if (!concurrent) expect(textOf(doc)).toBe(file);
      },
      { testCases: 300 },
    );
  });

  test("resumed twice, on this device or on two, the change enters once (ME4)", async () => {
    await hegel.testAsync(
      async (tc) => {
        const first = new LoroDoc();
        first.setPeerId(1n);
        typeInto(first, edited(tc, "", ["a", "b", "\n"]));
        const base = first.frontiers();
        const file = edited(tc, textOf(first), ["x", "y"]);
        const second = new LoroDoc();
        second.setPeerId(2n);
        second.import(first.export({ mode: "snapshot" }));

        const one = await resume(first, base, file);
        await resume(first, base, file);
        const two = await resume(second, base, file);
        first.import(two);
        second.import(one);

        expect(textOf(first)).toBe(file);
        expect(textOf(second)).toBe(file);
      },
      { testCases: 200 },
    );
  });

  test("its peer is drawn from the document, the base and the text", async () => {
    const doc = new LoroDoc();
    typeInto(doc, "a");
    const base = doc.frontiers();
    const peer = await resumePeer("doc", base, "ab");
    expect(await resumePeer("doc", base, "ab")).toBe(peer);
    expect(await resumePeer("doc", base, "ac")).not.toBe(peer);
    expect(await resumePeer("other", base, "ab")).not.toBe(peer);
    expect(await resumePeer("doc", [], "ab")).not.toBe(peer);
    expect(peer).toBeGreaterThanOrEqual(0n);
    expect(peer).toBeLessThan(2n ** 64n - 1n);
  });

  test("leaves the document as it is: the change is the caller's to import", () => {
    const doc = new LoroDoc();
    typeInto(doc, "a");
    const version = doc.oplogVersion();
    resumeChange(doc, doc.frontiers(), "ab", 7n);
    expect(doc.oplogVersion().compare(version)).toBe(0);
  });
});
