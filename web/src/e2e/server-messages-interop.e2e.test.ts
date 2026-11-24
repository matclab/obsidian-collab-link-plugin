// @vitest-environment node
//
// Phase 9, 9c.3 (C1): what the server sends is external input. The
// official decoder against the independent client's (written from the
// specification alone), on hostile text messages: neither throws out of
// its contract, both reach the same verdict — ignored (W-44), malformed
// so the connection closes and resumes (W-47), or the same decoded
// message (W-1, W-2, W-45, W-46).
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeAll, describe, expect, test } from "vitest";
import { vectors } from "../../lib/src/test-support/vectors.js";
import { decodeServerText } from "../../lib/src/transport/protocol.js";
import { linkIndependentLoro } from "./independent-loro.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

beforeAll(async () => {
  linkIndependentLoro();
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/protocol.mjs");
});

const JOURNALED = ["content", "annotations", "decisions"];
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const INTEGERS = [
  "0",
  "1",
  "7",
  "-1",
  "1.5",
  "1e3",
  "9007199254740991",
  "9007199254740992",
  '"1"',
  "null",
  "true",
];
const BLOBS = [
  '"AQID"',
  '"AQ=="',
  '""',
  '"AQ"',
  '"AQI"',
  '"A==="',
  '"%%"',
  '"AQ ID"',
  '"AQ==\\n"',
  "5",
  "null",
];
const CHANNELS = [
  '"content"',
  '"annotations"',
  '"decisions"',
  '"presence"',
  '"comments"',
  '"Content"',
  "5",
  "null",
];

/** A JSON value as text, for a field of a server message. */
function value(tc: TC, field: string): string {
  const pools = new Map<string, string[]>([
    ["authenticated", ['"read"', '"suggest"', '"edit"', '"admin"', "1"]],
    ["generation", INTEGERS],
    ["expires_at", [...INTEGERS, "null"]],
    ["v", INTEGERS],
    ["ack", CHANNELS],
    ["seq", INTEGERS],
    ["rotated", INTEGERS],
    ["expiry", [...INTEGERS, "null"]],
  ]);
  if (field === "history") {
    const entries = Array.from(
      { length: tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) },
      () => {
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
          return tc.draw(gs.sampledFrom(["null", "1", "[]", '"x"']));
        }
        const members = ["channel", "seq", "blob"]
          .filter(() => tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) > 0)
          .map((name) => {
            const pool =
              name === "channel" ? CHANNELS : name === "seq" ? INTEGERS : BLOBS;
            const good = tc.draw(gs.booleans());
            const chosen = good
              ? (pool[name === "seq" ? 2 : 0] as string)
              : tc.draw(gs.sampledFrom(pool));
            return `"${name}":${chosen}`;
          });
        return `{${members.join(",")}}`;
      },
    );
    return tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0
      ? tc.draw(gs.sampledFrom(["null", "{}", '"x"']))
      : `[${entries.join(",")}]`;
  }
  const pool = pools.get(field) ?? ['"x"', "1", "{}"];
  // Mostly a valid value, so that messages are often well formed.
  return tc.draw(gs.booleans())
    ? (pool[field === "authenticated" ? 2 : 2] ?? (pool[0] as string))
    : tc.draw(gs.sampledFrom(pool));
}

const SHAPES: Record<string, string[]> = {
  authenticated: ["authenticated", "generation", "expires_at", "v"],
  history: ["history"],
  ack: ["ack", "seq"],
  rotated: ["rotated"],
  expiry: ["expiry"],
  unknown: ["notice", "channel", "seq"],
};

/** A server text message: one of the known shapes, fields missing or
 * of the wrong type, an extra key of another message or an unknown one;
 * or not an object at all; or a vector. */
function message(tc: TC): string {
  const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 19 }));
  if (kind === 0)
    return tc.draw(gs.sampledFrom(["null", "1", "[]", '"x"', "", "{", "[{}]"]));
  if (kind === 1) {
    const all = [
      ...vectors.wire.server_messages,
      ...vectors.wire.server_messages_ignored,
      ...vectors.wire.server_messages_with_unknown_fields,
      ...vectors.wire.server_messages_malformed,
    ] as { json: unknown }[];
    return JSON.stringify(tc.draw(gs.sampledFrom(all)).json);
  }
  const shape = tc.draw(gs.sampledFrom(Object.keys(SHAPES)));
  const fields = (SHAPES[shape] as string[]).filter(
    (field, i) =>
      i === 0 || tc.draw(gs.integers({ minValue: 0, maxValue: 7 })) > 0,
  );
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) {
    fields.push(
      tc.draw(gs.sampledFrom(["ack", "rotated", "more", "seq", "v"])),
    );
  }
  return `{${[...new Set(fields)].map((field) => `"${field}":${value(tc, field)}`).join(",")}}`;
}

/** The official verdict, in the independent client's terms. */
function official(text: string): unknown {
  let decoded: ReturnType<typeof decodeServerText>;
  try {
    decoded = decodeServerText(text);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: "malformed" };
  }
  switch (decoded.kind) {
    case "unknown":
      return { kind: "ignored" };
    case "history":
      return {
        kind: "history",
        entries: decoded.entries.map(({ channel, seq, blob }) => ({
          channel,
          seq,
          blob: hex(blob),
        })),
      };
    default:
      return decoded;
  }
}

/** The independent verdict; an ack of a channel that isn't journaled
 * pairs with no frame: malformed too (W-47). */
function theirs(text: string): unknown {
  const decoded = independent.decodeServerMessage(text);
  switch (decoded.kind) {
    case "malformed":
      return { kind: "malformed" };
    case "ack":
      return JOURNALED.includes(decoded.channel)
        ? decoded
        : { kind: "malformed" };
    case "history":
      return {
        kind: "history",
        entries: decoded.entries.map(
          ({
            channel,
            seq,
            blob,
          }: { channel: string; seq: number; blob: Uint8Array }) => ({
            channel,
            seq,
            blob: hex(blob),
          }),
        ),
      };
    default:
      return decoded;
  }
}

describe("server text messages, official and independent decoders, property", () => {
  test(
    "a hostile message: the same verdict on both sides",
    () =>
      hegel.test(
        (tc) => {
          const text = message(tc);
          expect(official(text), text).toEqual(theirs(text));
        },
        { testCases: 3000 },
      ),
    60_000,
  );
});
