// Phase 9, 9c.3 (C8): presence states come from any editor or reviewer.
// Whatever they send — malformed states, cursors that don't decode, that
// point at an operation not yet arrived, at another container, or that
// would trap Loro (D-37) — `receive` and `others` never throw, the text
// is left intact, and what is shown is the highest valid state of each
// page (D-32, D-33).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hostileCursorBytes } from "../test-support/hostile-cursor.js";
import { Presence } from "./presence.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const TEXT = "hello world";
const KEYS = ["0".repeat(32), "1".repeat(32), "ab".repeat(16)];
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The text, and cursors a page may send, with where each must show:
 * a position, `undefined` (not shown), or `"any"` (bytes that may happen
 * to decode). */
function setting() {
  const doc = new LoroDoc();
  doc.setPeerId(1n);
  doc.getText("content").insert(0, TEXT);
  doc.commit();
  const ahead = doc.fork();
  ahead.setPeerId(2n);
  ahead.getText("content").insert(0, "not yet here ");
  ahead.commit();
  const elsewhere = new LoroDoc();
  elsewhere.setPeerId(3n);
  elsewhere.getText("notes").insert(0, TEXT);
  elsewhere.commit();
  const at = (source: LoroDoc, name: string, offset: number) => {
    const bytes = source.getText(name).getCursor(offset)?.encode();
    if (!bytes) throw new Error("no cursor");
    return bytes;
  };
  const cursors: { encoded: string; shows: number | undefined | "any" }[] = [
    ...[0, 3, 6, 11].map((offset) => ({
      encoded: b64(at(doc, "content", offset)),
      shows: offset,
    })),
    { encoded: b64(at(ahead, "content", 2)), shows: undefined },
    { encoded: b64(at(elsewhere, "notes", 2)), shows: undefined },
    { encoded: b64(hostileCursorBytes()), shows: undefined },
    { encoded: "", shows: undefined },
    { encoded: "AQID", shows: "any" },
  ];
  return { doc, cursors };
}

type Expected = {
  seq: number;
  gone: boolean;
  name: string;
  color: string;
  anchor: number | undefined | "any";
  head: number | undefined | "any";
};

/** A state that D-32 accepts, with what it must show. */
function validState(
  tc: TC,
  cursors: ReturnType<typeof setting>["cursors"],
): { json: Record<string, unknown>; expected: Expected; key: string } {
  const key = tc.draw(gs.sampledFrom(KEYS));
  const seq = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) {
    return {
      key,
      json: { v: 1, key, seq, gone: true, name: 7 },
      expected: {
        seq,
        gone: true,
        name: "",
        color: "",
        anchor: undefined,
        head: undefined,
      },
    };
  }
  const name = tc.draw(
    gs.sampledFrom(["bob", "", "é", "n".repeat(200), "<b>"]),
  );
  const color = tc.draw(gs.sampledFrom(["#d1495b", "#000000"]));
  const anchor = tc.draw(gs.booleans())
    ? tc.draw(gs.sampledFrom(cursors))
    : undefined;
  const head = tc.draw(gs.booleans())
    ? tc.draw(gs.sampledFrom(cursors))
    : undefined;
  return {
    key,
    json: {
      v: 1,
      key,
      seq,
      name,
      color,
      ...(anchor && { anchor: anchor.encoded }),
      ...(head && { head: head.encoded }),
      ...(tc.draw(gs.booleans()) && { unknown: [1, { x: null }] }),
    },
    expected: {
      seq,
      gone: false,
      name,
      color,
      anchor: anchor?.shows,
      head: head?.shows,
    },
  };
}

/** The same state broken on one point D-32 checks. */
function invalidState(tc: TC, json: Record<string, unknown>): unknown {
  const broken = { ...json };
  switch (
    tc.draw(
      gs.sampledFrom([
        "v",
        "key",
        "seq",
        "name",
        "color",
        "anchor",
        "array",
        "scalar",
      ]),
    )
  ) {
    case "v":
      broken.v = tc.draw(gs.sampledFrom([2, "1", null, undefined]));
      break;
    case "key":
      broken.key = tc.draw(gs.sampledFrom(["A".repeat(32), "0".repeat(31), 1]));
      break;
    case "seq":
      broken.seq = tc.draw(gs.sampledFrom([0, -1, 1.5, 2 ** 53, "1", null]));
      break;
    case "name":
      if (broken.gone === true) return [broken];
      broken.name = tc.draw(gs.sampledFrom(["n".repeat(201), 1, null]));
      break;
    case "color":
      if (broken.gone === true) return [broken];
      broken.color = tc.draw(
        gs.sampledFrom(["#D1495B", "red", "#12345", null]),
      );
      break;
    case "anchor":
      if (broken.gone === true) return [broken];
      broken.anchor = tc.draw(
        gs.sampledFrom(["%%", "A".repeat(257), 12, null]),
      );
      break;
    case "array":
      return [broken];
    default:
      return tc.draw(gs.sampledFrom([null, 1, "x", true]));
  }
  return broken;
}

function mutated(tc: TC, bytes: Uint8Array): Uint8Array {
  const out = [...bytes];
  const at = tc.draw(gs.integers({ minValue: 0, maxValue: out.length }));
  const byte = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
  switch (tc.draw(gs.sampledFrom(["flip", "insert", "remove", "cut"]))) {
    case "flip":
      if (at < out.length) out[at] = byte;
      break;
    case "insert":
      out.splice(at, 0, byte);
      break;
    case "remove":
      out.splice(at, 1);
      break;
    default:
      out.length = at;
  }
  return Uint8Array.from(out);
}

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("presence, hostile states, property", () => {
  test(
    "never a throw, the text intact, the highest valid state of each page shown",
    () =>
      hegel.test(
        (tc) => {
          const { doc, cursors } = setting();
          const presence = new Presence({
            doc,
            name: () => "me",
            publish: () => {},
          });
          const model = new Map<string, Expected>();
          // False once bytes whose validity this test doesn't know arrived,
          // until everything has expired.
          let exact = true;
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 15 }));
          for (let step = 0; step < steps; step++) {
            const { json, expected, key } = validState(tc, cursors);
            switch (
              tc.draw(
                gs.sampledFrom([
                  "valid",
                  "valid",
                  "invalid",
                  "bytes",
                  "wait",
                  "expire",
                ]),
              )
            ) {
              case "valid": {
                presence.receive(encode(json));
                const known = model.get(key);
                if (!known || known.seq < expected.seq)
                  model.set(key, expected);
                break;
              }
              case "invalid":
                presence.receive(encode(invalidState(tc, json)));
                break;
              case "bytes":
                presence.receive(mutated(tc, encode(json)));
                exact = false;
                break;
              case "wait":
                vi.advanceTimersByTime(1_000);
                break;
              default:
                vi.advanceTimersByTime(40_000);
                model.clear();
                exact = true;
            }

            const others = presence.others();
            expect(doc.getText("content").toString()).toBe(TEXT);
            doc.export({ mode: "snapshot" }); // still usable
            expect(new Set(others.map((other) => other.key)).size).toBe(
              others.length,
            );
            for (const other of others) {
              expect(other.name.length).toBeLessThanOrEqual(200);
              expect(other.color).toMatch(/^#[0-9a-f]{6}$/);
              for (const offset of [other.anchor, other.head]) {
                if (offset === undefined) continue;
                expect(Number.isInteger(offset)).toBe(true);
                expect(offset).toBeGreaterThanOrEqual(0);
                expect(offset).toBeLessThanOrEqual(TEXT.length);
              }
            }
            if (!exact) continue;
            const shown = [...model]
              .filter(([, state]) => !state.gone)
              .map(([key]) => key)
              .sort();
            expect(others.map((other) => other.key)).toEqual(shown);
            for (const other of others) {
              const state = model.get(other.key) as Expected;
              expect(other.name).toBe(state.name);
              expect(other.color).toBe(state.color);
              if (state.anchor !== "any")
                expect(other.anchor).toBe(state.anchor);
              if (state.head !== "any") expect(other.head).toBe(state.head);
            }
          }
          presence.destroy();
        },
        { testCases: 300 },
      ),
    60_000,
  );
});
