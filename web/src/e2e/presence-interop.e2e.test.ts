// @vitest-environment node
//
// Phase 9, 9c.3 (C8): presence states are sent by any editor or reviewer;
// every page must show the same participants (D-31, D-32). The official
// client against the independent one (written from the specification
// alone), on hostile states: same verdict, same name and color.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { LoroDoc } from "loro-crdt";
import { beforeAll, describe, expect, test } from "vitest";
import { Presence } from "../../lib/src/index.js";
import { fromHex, vectors } from "../../lib/src/test-support/vectors.js";
import { linkIndependentLoro } from "./independent-loro.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

/** A JSON value as text, among those D-31 and D-32 tell apart. */
function value(tc: TC, key: string): string {
  const typical = new Map<string, string[]>([
    ["v", ["1", "1.0", "2", '"1"']],
    [
      "key",
      [
        '"00000000000000000000000000000000"',
        '"0000000000000000000000000000000A"',
        '"000"',
      ],
    ],
    [
      "seq",
      [
        "1",
        "7",
        "0",
        "-1",
        "1.5",
        "9007199254740991",
        "9007199254740992",
        "1e3",
      ],
    ],
    ["gone", ["true", "false", "1", "null"]],
    [
      "name",
      [
        '"bob"',
        '""',
        JSON.stringify("n".repeat(200)),
        JSON.stringify("n".repeat(201)),
        JSON.stringify("é".repeat(200)),
        '"\\ud800"',
        "null",
      ],
    ],
    ["color", ['"#d1495b"', '"#D1495B"', '"#d1495"', '"red"']],
    [
      "anchor",
      [
        '"AQID"',
        '"AQ=="',
        '"AQ"',
        '"AQI"',
        '"A"',
        '"QR=="',
        '"===="',
        '""',
        '"%%"',
        JSON.stringify("A".repeat(256)),
        JSON.stringify("A".repeat(257)),
        "12",
        "null",
      ],
    ],
  ]);
  const pool = typical.get(key === "head" ? "anchor" : key) ?? [
    '"x"',
    "{}",
    "[]",
  ];
  return tc.draw(gs.sampledFrom(pool));
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

/** A state as a page could send it: the usual fields, mostly with typical
 * values, some missing, repeated or unknown; or a vector, mutated. */
function state(tc: TC): Uint8Array {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
  if (kind === 0) {
    const vector = tc.draw(gs.sampledFrom(vectors.document.presence)) as {
      plaintext: string;
    };
    return mutated(tc, fromHex(vector.plaintext));
  }
  const keys = ["v", "key", "seq", "name", "color"].filter(
    () => tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) > 0,
  );
  for (const optional of ["anchor", "head", "gone", "x"]) {
    if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0)
      keys.push(optional);
  }
  const members = keys.map((key) => {
    // Mostly the first, valid, value: so that states are often shown.
    const valid = tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) > 0;
    const first = new Map([
      ["v", "1"],
      ["key", '"00000000000000000000000000000000"'],
      ["seq", "1"],
      ["name", '"bob"'],
      ["color", '"#d1495b"'],
      ["anchor", '"AQID"'],
      ["head", '"AQID"'],
    ]).get(key);
    return `${JSON.stringify(key)}:${valid && first ? first : value(tc, key)}`;
  });
  const bytes = utf8(`{${members.join(",")}}`);
  return kind === 1 ? mutated(tc, bytes) : bytes;
}

describe("presence states, official and independent clients, property", () => {
  test(
    "a hostile state: neither throws, both show the same participant",
    () =>
      hegel.test(
        (tc) => {
          const bytes = state(tc);
          const doc = new LoroDoc();
          doc.getText("content").insert(0, "hello");
          doc.commit();
          const presence = new Presence({
            doc,
            name: () => "me",
            publish: () => {},
          });
          presence.receive(bytes);
          const [shown] = presence.others();
          presence.destroy();
          const theirs = independent.parsePresence(bytes);
          expect(
            shown && { key: shown.key, name: shown.name, color: shown.color },
          ).toEqual(
            theirs && !theirs.gone
              ? { key: theirs.key, name: theirs.name, color: theirs.color }
              : undefined,
          );
        },
        { testCases: 3000 },
      ),
    60_000,
  );
});
