import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { anchorRange, resolveRange } from "../../lib/src/annotations/anchor.js";
import { createPeer, syncAll } from "../../lib/src/test-support/peers.js";

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-";

// Generalizes choice/loro/t1-cursor-range-anchoring/run.mjs into a generative
// model-based/commutativity property: a range anchored by two Cursor objects
// (start+end) must resolve to the exact same substring on every peer, no
// matter how many other peers concurrently edited the document before
// everyone synced up. This is the anchoring property CriticMarkup ranges
// (docs/adr/0003-*.md) depend on. Goes through annotations/anchor.ts's
// anchorRange/resolveRange (phase-4 §1) rather than calling
// getCursor/getCursorPos directly, so the anchoring logic is exercised
// through the one reusable implementation rather than duplicated here.
describe("anchored range convergence under concurrent edits (generalizes T1)", () => {
  test("a range anchored on one peer resolves identically on every peer after sync", () =>
    hegel.testAsync(async (tc) => {
      const base = tc.draw(
        gs.text({ minSize: 2, maxSize: 40, alphabet: ALPHABET }),
      );

      const author = createPeer();
      author.getText("doc").insert(0, base);

      const reviewer = createPeer();
      const peerCount = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
      const editors = Array.from({ length: peerCount }, () => createPeer());
      syncAll([author, reviewer, ...editors]);

      const start = tc.draw(
        gs.integers({ minValue: 0, maxValue: base.length }),
      );
      const end = tc.draw(
        gs.integers({ minValue: start, maxValue: base.length }),
      );

      const anchor = anchorRange(reviewer.getText("doc"), start, end);
      if (!anchor) return; // empty document, nothing to anchor

      for (const editor of editors) {
        const text = editor.getText("doc");
        const len = text.toString().length;
        const op = tc.draw(gs.sampledFrom(["insert", "delete"] as const));
        if (op === "insert" || len === 0) {
          const pos = tc.draw(gs.integers({ minValue: 0, maxValue: len }));
          const inserted = tc.draw(
            gs.text({ minSize: 1, maxSize: 10, alphabet: ALPHABET }),
          );
          text.insert(pos, inserted);
        } else {
          const pos = tc.draw(gs.integers({ minValue: 0, maxValue: len - 1 }));
          const delLen = tc.draw(
            gs.integers({ minValue: 1, maxValue: len - pos }),
          );
          text.delete(pos, delLen);
        }
      }

      syncAll([author, reviewer, ...editors]);

      const peers = [author, reviewer, ...editors];
      const resolutions = peers.map((peer) => {
        const resolved = resolveRange(peer, anchor);
        if (!resolved) return { resolved: false as const };
        const text = peer.getText("doc").toString();
        const { start: s, end: e } = resolved;
        return {
          resolved: true as const,
          substring: s <= e ? text.slice(s, e) : `<INVALID ${s}>${e}`,
        };
      });

      const first = resolutions[0];
      if (!first) throw new Error("no peers");
      for (const r of resolutions) {
        if (r.resolved !== first.resolved) {
          throw new Error(
            `resolved-ness diverged across peers: ${JSON.stringify(resolutions)}`,
          );
        }
        if (r.resolved && first.resolved && r.substring !== first.substring) {
          throw new Error(
            `resolved substring diverged across peers: ${JSON.stringify(resolutions)}`,
          );
        }
      }
    }));
});
