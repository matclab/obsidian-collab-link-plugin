import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { describe, test } from "vitest";
import { anchorRange, resolveRange } from "./anchor.js";

// ADR-0014's rule against a model: a character inserted later belongs to
// the range iff both its neighbours do at the time — so insertions at either
// boundary stay outside and insertions strictly inside extend it. Edits
// never remove the range's first or last character: once the anchored last
// character is deleted, text typed right after what remains enters the
// range (Loro places it before the tombstone) — the limitation ADR-0014
// accepts, out of this model.
describe("anchored range boundaries (property, ADR-0014)", () => {
  test("a range holds exactly its characters plus those inserted strictly inside", () =>
    hegel.test((tc) => {
      const base = tc.draw(
        gs.text({ minSize: 2, maxSize: 12, alphabet: "ab" }),
      );
      const start = tc.draw(
        gs.integers({ minValue: 0, maxValue: base.length - 1 }),
      );
      const end = tc.draw(
        gs.integers({ minValue: start + 1, maxValue: base.length }),
      );
      const doc = new LoroDoc();
      const text = doc.getText("content");
      text.insert(0, base);
      doc.commit();
      const anchor = anchorRange(text, start, end);
      if (!anchor) throw new Error("no anchor");

      // Model: one flag per visible character, plus which ones are anchored.
      const inside = [...base].map((_, i) => i >= start && i < end);
      const anchored = [...base].map((_, i) => i === start || i === end - 1);
      const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 15 }));
      for (let s = 0; s < steps; s++) {
        const pos = tc.draw(
          gs.integers({ minValue: 0, maxValue: inside.length }),
        );
        if (tc.draw(gs.booleans()) && pos < inside.length && !anchored[pos]) {
          text.delete(pos, 1);
          inside.splice(pos, 1);
          anchored.splice(pos, 1);
        } else {
          text.insert(pos, "X");
          const within =
            pos > 0 &&
            pos < inside.length &&
            !!inside[pos - 1] &&
            !!inside[pos];
          inside.splice(pos, 0, within);
          anchored.splice(pos, 0, false);
        }
        doc.commit();
      }

      const expectedStart = inside.indexOf(true);
      const expectedEnd = inside.lastIndexOf(true) + 1;
      const resolved = resolveRange(doc, anchor);
      if (resolved?.start !== expectedStart || resolved.end !== expectedEnd) {
        throw new Error(
          `expected [${expectedStart},${expectedEnd}) in ${JSON.stringify(text.toString())}, got ${JSON.stringify(resolved)}`,
        );
      }
    }));
});
