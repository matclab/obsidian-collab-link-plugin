import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, LoroMap, type OpId } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { listVersions } from "../../lib/src/index.js";
import { diffVersions, restoreText, textAt } from "./text.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** A content doc typed by two or three peers, synced now and then. */
function content(tc: TC): LoroDoc {
  const count = tc.draw(gs.integers({ minValue: 2, maxValue: 3 }));
  const docs = Array.from({ length: count }, (_, i) => {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(i + 1));
    return doc;
  });
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
  for (let step = 0; step < steps; step++) {
    const doc = tc.draw(gs.sampledFrom(docs));
    const text = doc.getText("content");
    if (text.length > 0 && tc.draw(gs.booleans())) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: text.length - 1 }),
      );
      text.delete(at, 1);
    } else {
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
      text.insert(at, tc.draw(gs.sampledFrom(["a", "bc", "def"])));
    }
    doc.commit();
    if (tc.draw(gs.booleans())) {
      const other = tc.draw(gs.sampledFrom(docs));
      other.import(doc.export({ mode: "update", from: other.oplogVersion() }));
    }
  }
  const [first, ...others] = docs as [LoroDoc, ...LoroDoc[]];
  for (const other of others) {
    first.import(other.export({ mode: "update", from: first.oplogVersion() }));
  }
  return first;
}

/** One frontier item a reviewer may write: an operation the content doc
 * holds (in the middle of a change, an ancestor of another, the same one
 * twice), one it does not hold yet, a peer out of range, or no item at all. */
function item(tc: TC, doc: LoroDoc, onlyHeld: boolean): unknown {
  const held = [...doc.oplogVersion().toJSON()];
  const kind = onlyHeld
    ? "held"
    : tc.draw(
        gs.sampledFrom([
          "held",
          "held",
          "held",
          "ahead",
          "peer",
          "peer",
          "peer",
          "counter",
          "junk",
        ]),
      );
  if (kind === "held" || kind === "ahead") {
    const [peer, end] = tc.draw(gs.sampledFrom(held));
    const counter =
      kind === "held"
        ? tc.draw(gs.integers({ minValue: 0, maxValue: end - 1 }))
        : end + tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    return { peer, counter };
  }
  if (kind === "peer") {
    return {
      peer: tc.draw(
        gs.sampledFrom([
          "0",
          "01",
          "18446744073709551615",
          "18446744073709551616",
          "99999999999999999999999999",
        ]),
      ),
      counter: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })),
    };
  }
  if (kind === "counter") {
    return {
      peer: tc.draw(gs.sampledFrom(held))[0],
      counter: tc.draw(
        gs.sampledFrom([
          2 ** 31 - 1,
          2 ** 31,
          2 ** 32,
          Number.MAX_SAFE_INTEGER,
        ]),
      ),
    };
  }
  return tc.draw(
    gs.sampledFrom<unknown>([
      null,
      1,
      "1",
      [],
      {},
      { peer: 1, counter: 0 },
      { peer: "1", counter: -1 },
      { peer: "1", counter: 0.5 },
      { peer: "1", counter: "0" },
      { peer: "-1", counter: 0 },
    ]),
  );
}

/** Writes 1 to 4 entries in `versions`, as a reviewer with the key may:
 * well-formed or not, frontiers hostile or not. */
function hostileVersions(tc: TC, contentDoc: LoroDoc): LoroDoc {
  const annotations = new LoroDoc();
  const table = annotations.getMap("versions");
  const entries = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  for (let i = 0; i < entries; i++) {
    const id = `v${i}`;
    if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
      table.set(id, tc.draw(gs.sampledFrom<unknown>(["x", 1, null, [1]])));
      continue;
    }
    const entry = table.setContainer(id, new LoroMap());
    // Mostly well-formed fields, so that hostile frontiers get read.
    const malformed = tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0;
    entry.set(
      "name",
      malformed
        ? tc.draw(gs.sampledFrom<unknown>(["", 1, "x".repeat(201)]))
        : "v",
    );
    entry.set("author", malformed ? 2 : "alice");
    entry.set("at", malformed ? "now" : i);
    const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
    // Often only operations the doc holds: incoherent, yet available.
    const onlyHeld = tc.draw(gs.booleans());
    const frontiers = Array.from({ length: count }, () =>
      item(tc, contentDoc, onlyHeld),
    );
    entry.set(
      "frontiers",
      tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
        ? tc.draw(gs.sampledFrom<unknown>([null, "1", { peer: "1" }]))
        : frontiers,
    );
  }
  annotations.commit();
  return annotations;
}

/** The text at the version every listed operation reaches, with what it
 * depends on: `frontiers` as Loro reads them, made coherent. */
function expectedText(doc: LoroDoc, frontiers: OpId[]): string {
  return textAt(doc, doc.vvToFrontiers(doc.frontiersToVV(frontiers)));
}

describe("versions table written by a reviewer, property", () => {
  test(
    "listing, viewing, comparing and restoring hostile versions never throw, nor corrupt the text",
    () =>
      hegel.test(
        (tc) => {
          const contentDoc = content(tc);
          const annotations = hostileVersions(tc, contentDoc);
          const text = contentDoc.getText("content").toString();
          const version = contentDoc.oplogVersion();

          const versions = listVersions(annotations, contentDoc);
          for (const named of versions) {
            if (!named.available) continue;
            const shown = textAt(contentDoc, named.frontiers);
            expect(shown).toBe(expectedText(contentDoc, named.frontiers));
            contentDoc.frontiersToVV(named.frontiers).compare(version);
            const segments = diffVersions(
              contentDoc,
              named.frontiers,
              contentDoc.frontiers(),
            );
            const join = (kinds: string[]) =>
              segments
                .filter((segment) => kinds.includes(segment.kind))
                .map((segment) => segment.text)
                .join("");
            expect(join(["same", "added"])).toBe(text);
            expect(join(["same", "removed"])).toBe(shown);
            // Viewing leaves the doc as it was.
            expect(contentDoc.getText("content").toString()).toBe(text);
            expect(contentDoc.oplogVersion().compare(version)).toBe(0);

            const restorer = contentDoc.fork();
            restorer.setPeerId(100n);
            restoreText(restorer, named.frontiers, "restored");
            expect(restorer.getText("content").toString()).toBe(shown);
            const newcomer = new LoroDoc();
            newcomer.import(restorer.export({ mode: "snapshot" }));
            expect(newcomer.getText("content").toString()).toBe(shown);
          }
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
