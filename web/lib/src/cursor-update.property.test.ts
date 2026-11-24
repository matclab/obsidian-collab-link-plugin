// What E3 (docs/phase-9-durcissement.md, *Analyse 9e.3*) relies on: when
// a cursor's character is deleted, `getCursorPos` returns, in `update`,
// a cursor on a living character. Kept in its place, it must give the
// same position as the original after any later edit, concurrent ones
// included — or keeping it would move annotations. Not when the text was
// empty: the update then names no character, and an insertion where the
// deleted text was may land on either side (found by this property).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { type Cursor, LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { resolveCursor } from "./cursor.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

function edit(tc: TC, doc: LoroDoc): void {
  const text = doc.getText("content");
  if (text.length > 0 && tc.draw(gs.booleans())) {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length - 1 }));
    const length = tc.draw(
      gs.integers({ minValue: 1, maxValue: Math.min(4, text.length - at) }),
    );
    text.delete(at, length);
  } else {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: text.length }));
    text.insert(at, tc.draw(gs.sampledFrom(["a", "bc", "def"])));
  }
  doc.commit();
}

describe("a cursor's update, kept by resolveCursor, property", () => {
  test(
    "gives the same position as the original, whatever is edited after",
    () =>
      hegel.test(
        (tc) => {
          const a = new LoroDoc();
          a.setPeerId(1n);
          a.getText("content").insert(
            0,
            tc.draw(gs.sampledFrom(["hi", "hello world"])),
          );
          a.commit();
          const b = new LoroDoc();
          b.setPeerId(2n);
          b.import(a.export({ mode: "snapshot" }));
          const text = a.getText("content");
          const at = tc.draw(
            gs.integers({ minValue: 0, maxValue: text.length - 1 }),
          );
          const side = tc.draw(gs.sampledFrom([-1, 0, 1] as const));
          const original = text.getCursor(at, side) as Cursor;
          // Edits on both peers, then the cursor's character deleted on one.
          for (
            let i = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
            i > 0;
            i--
          ) {
            edit(tc, tc.draw(gs.booleans()) ? a : b);
          }
          const deleter = tc.draw(gs.booleans()) ? a : b;
          const position = deleter.getCursorPos(original)?.offset ?? 0;
          const length = deleter.getText("content").length;
          if (position < length) {
            deleter.getText("content").delete(position, 1);
            deleter.commit();
          }
          const sync = () => {
            a.import(b.export({ mode: "update", from: a.oplogVersion() }));
            b.import(a.export({ mode: "update", from: b.oplogVersion() }));
          };
          sync();
          const resolved = a.getCursorPos(original);
          if (!resolved) throw new Error("unresolved");
          const update = resolved.update ?? original;
          expect(a.getCursorPos(update)?.offset).toBe(resolved.offset);
          // What resolveCursor keeps, on both peers.
          resolveCursor(a, original, undefined, true);
          resolveCursor(b, original, undefined, true);
          // Later edits, concurrent on both peers, then merged.
          for (
            let i = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
            i > 0;
            i--
          ) {
            edit(tc, tc.draw(gs.booleans()) ? a : b);
          }
          sync();
          for (const doc of [a, b]) {
            const exact = doc.getCursorPos(original);
            const kept = resolveCursor(doc, original, undefined, true);
            expect(kept?.offset).toBe(exact?.offset);
            // Still told that the character is gone (D-13 reads it).
            expect(kept?.update !== undefined).toBe(
              exact?.update !== undefined,
            );
            // Loro's update alone, kept even when it names no character,
            // would not (an insertion where the emptied text was).
            if (update.pos() !== undefined) {
              expect(doc.getCursorPos(update)?.offset).toBe(exact?.offset);
            }
          }
        },
        { testCases: 1000 },
      ),
    60_000,
  );
});
