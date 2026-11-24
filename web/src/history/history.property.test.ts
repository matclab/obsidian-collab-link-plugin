import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc, type OpId } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { diffVersions, restoreText, textAt } from "./text.js";
import {
  DEFAULT_PAUSE_SECONDS,
  type VersionGroup,
  groupVersions,
} from "./versions.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

/** A random history: 2 or 3 pages typing and deleting, each with its own
 * clock, syncing now and then. Returns every page, all synced, and the
 * pseudonym of each peer (two may share one). */
function history(tc: TC) {
  const count = tc.draw(gs.integers({ minValue: 2, maxValue: 3 }));
  const pages = Array.from({ length: count }, (_, i) => {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(i + 1));
    doc.setRecordTimestamp(true);
    doc.setChangeMergeInterval(60);
    return { doc, clock: 1000 };
  });
  const names = new Map(
    pages.map(({ doc }) => [
      doc.peerIdStr as string,
      tc.draw(gs.sampledFrom(["alice", "bob"])),
    ]),
  );
  const sync = (from: LoroDoc, to: LoroDoc) =>
    to.import(from.export({ mode: "update", from: to.oplogVersion() }));
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 25 }));
  for (let step = 0; step < steps; step++) {
    const page = tc.draw(gs.sampledFrom(pages));
    page.clock += tc.draw(gs.sampledFrom([0, 10, 59, 61, 200, 299, 301, 700]));
    const text = page.doc.getText("content");
    if (text.length > 0 && tc.draw(gs.booleans())) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: text.length - 1 }),
      );
      const length = tc.draw(
        gs.integers({ minValue: 1, maxValue: text.length - at }),
      );
      text.delete(at, length);
    } else {
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
      text.insert(at, tc.draw(gs.sampledFrom(["a", "bc", "def", "\n"])));
    }
    page.doc.setNextCommitTimestamp(page.clock);
    page.doc.commit();
    if (tc.draw(gs.booleans())) {
      const other = tc.draw(gs.sampledFrom(pages));
      if (other !== page) sync(page.doc, other.doc);
    }
  }
  for (const a of pages) for (const b of pages) if (a !== b) sync(a.doc, b.doc);
  const docs = pages.map(({ doc }) => doc);
  return { docs, authorOf: (peer: string) => names.get(peer) };
}

const vvOf = (doc: LoroDoc, frontiers: OpId[]) => doc.frontiersToVV(frontiers);
const keyOf = (
  group: VersionGroup,
  authorOf: (p: string) => string | undefined,
) =>
  group.changes.map((change) => authorOf(change.peer) ?? `peer:${change.peer}`);

describe("history, property", () => {
  test("the same versions on every peer; a partition of the changes into causal prefixes, cut by author and pause", () =>
    hegel.test((tc) => {
      const { docs, authorOf } = history(tc);
      const [first, ...others] = docs;
      if (!first) throw new Error("no page");
      const groups = groupVersions(first, authorOf);
      for (const other of others) {
        expect(groupVersions(other, authorOf)).toEqual(groups);
      }

      const ops = groups
        .flatMap((group) => group.changes)
        .reduce((sum, change) => sum + change.length, 0);
      const total = [...first.oplogVersion().toJSON().values()].reduce(
        (sum, end) => sum + end,
        0,
      );
      expect(ops).toBe(total);

      let previous: VersionGroup | undefined;
      for (const group of groups) {
        const keys = new Set(keyOf(group, authorOf));
        expect(keys.size).toBe(1);
        let end = group.start;
        for (const change of group.changes) {
          expect(change.timestamp - end).toBeLessThanOrEqual(
            DEFAULT_PAUSE_SECONDS,
          );
          end = Math.max(end, change.timestamp);
        }
        if (previous) {
          const order = vvOf(first, group.frontiers).compare(
            vvOf(first, previous.frontiers),
          );
          expect(order).toBe(1);
          const sameAuthor =
            keyOf(previous, authorOf)[0] === keyOf(group, authorOf)[0];
          if (sameAuthor) {
            expect(group.start - previous.end).toBeGreaterThan(
              DEFAULT_PAUSE_SECONDS,
            );
          }
        }
        previous = group;
      }
      if (previous) {
        expect(
          vvOf(first, previous.frontiers).compare(first.oplogVersion()),
        ).toBe(0);
        expect(textAt(first, previous.frontiers)).toBe(
          first.getText("content").toString(),
        );
      }
    }));

  test("a diff between two versions gives back both texts", () =>
    hegel.test((tc) => {
      const { docs, authorOf } = history(tc);
      const doc = docs[0] as LoroDoc;
      const frontiers = [
        [] as OpId[],
        ...groupVersions(doc, authorOf).map((g) => g.frontiers),
      ];
      const from = tc.draw(gs.sampledFrom(frontiers));
      const to = tc.draw(gs.sampledFrom(frontiers));
      const segments = diffVersions(doc, from, to);
      const join = (kinds: string[]) =>
        segments
          .filter((segment) => kinds.includes(segment.kind))
          .map((segment) => segment.text)
          .join("");
      expect(join(["same", "added"])).toBe(textAt(doc, to));
      expect(join(["same", "removed"])).toBe(textAt(doc, from));
    }));

  test("restoring a version gives its text, as an edit that merges with concurrent ones", () =>
    hegel.test((tc) => {
      const { docs, authorOf } = history(tc);
      const doc = docs[0] as LoroDoc;
      const groups = groupVersions(doc, authorOf);
      const target = tc.draw(
        gs.sampledFrom([[] as OpId[], ...groups.map((g) => g.frontiers)]),
      );
      const restorer = doc.fork();
      restorer.setPeerId(100n);
      const concurrent = doc.fork();
      concurrent.setPeerId(101n);
      const text = concurrent.getText("content");
      const typed = tc.draw(gs.booleans());
      if (typed) {
        text.insert(
          tc.draw(gs.integers({ minValue: 0, maxValue: text.length })),
          "Z",
        );
        concurrent.commit();
      }

      const wanted = textAt(doc, target);
      const changed = restoreText(restorer, target, "restored");
      expect(restorer.getText("content").toString()).toBe(wanted);
      expect(changed).toBe(wanted !== doc.getText("content").toString());

      restorer.import(
        concurrent.export({ mode: "update", from: restorer.oplogVersion() }),
      );
      concurrent.import(
        restorer.export({ mode: "update", from: concurrent.oplogVersion() }),
      );
      const merged = restorer.getText("content").toString();
      expect(concurrent.getText("content").toString()).toBe(merged);
      if (!typed) expect(merged).toBe(wanted);
      else expect(merged.replace("Z", "")).toBe(wanted);
    }));
});
