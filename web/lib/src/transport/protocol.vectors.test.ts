// The wire against the specification's vectors (docs/protocol/01-wire.md,
// docs/protocol/vectors.json): the messages this client writes, the server
// messages it reads, frames, close codes.
import { describe, expect, test } from "vitest";
import { base64UrlToBytes } from "../crypto/role-secrets.js";
import { createDocument } from "../links/links.js";
import { fromHex, toHex, vectors } from "../test-support/vectors.js";
import {
  CloseCode,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeServerText,
  encodeAuthMessage,
  encodeCompactMessage,
  encodeDeleteMessage,
  encodeExpireMessage,
  encodeFrame,
  encodeJoinMessage,
  encodeRotateMessage,
} from "./protocol.js";

const { wire } = vectors;
const message = (name: string) =>
  wire.client_messages.find((m: { name: string }) => m.name === name).json;

/** A decoded server message, its bytes in hex: comparable to a vector. */
function comparable(decoded: unknown): unknown {
  return JSON.parse(
    JSON.stringify(decoded, (_, value) =>
      value instanceof Uint8Array ? toHex(value) : value,
    ),
  );
}

describe("the wire, as the vectors say", () => {
  test("W-6, W-7: the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(wire.protocol_version);
  });

  test("§1.6: the messages this client writes", () => {
    const auth = message("auth");
    expect(
      JSON.parse(
        encodeAuthMessage(auth.auth, auth.role, base64UrlToBytes(auth.secret)),
      ),
    ).toEqual(auth);
    const join = message("join");
    expect(JSON.parse(encodeJoinMessage(join.join, join.channel))).toEqual(
      join,
    );
    const since = message("join since");
    expect(
      JSON.parse(encodeJoinMessage(since.join, since.channel, since.since)),
    ).toEqual(since);
    const compact = message("compact");
    expect(
      JSON.parse(
        encodeCompactMessage(
          compact.compact,
          compact.channel,
          compact.up_to_seq,
          Uint8Array.from(Buffer.from(compact.snapshot, "base64")),
        ),
      ),
    ).toEqual(compact);
    const rotate = message("rotate");
    expect(
      JSON.parse(
        encodeRotateMessage({
          read: base64UrlToBytes(rotate.rotate.read),
          suggest: base64UrlToBytes(rotate.rotate.suggest),
          edit: base64UrlToBytes(rotate.rotate.edit),
        }),
      ),
    ).toEqual(rotate);
    const remove = message("delete");
    expect(JSON.parse(encodeDeleteMessage(remove.delete))).toEqual(remove);
    for (const name of ["expire", "expire none"]) {
      const expire = message(name);
      expect(JSON.parse(encodeExpireMessage(expire.expire, expire.in))).toEqual(
        expire,
      );
    }
  });

  test("§1.3: the creation request has the vector's shape", async () => {
    let body: unknown;
    await createDocument("https://host", async (_, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ document_id: "d" }));
    });
    const expected = wire.create_document;
    expect(Object.keys(body as object).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    const { v, verifiers } = body as { v: number; verifiers: object };
    expect(v).toBe(expected.v);
    expect(Object.keys(verifiers).sort()).toEqual(
      Object.keys(expected.verifiers).sort(),
    );
  });

  test("§1.8: the server messages this client reads", () => {
    for (const { name, json, decoded } of wire.server_messages) {
      expect(comparable(decodeServerText(JSON.stringify(json))), name).toEqual(
        decoded,
      );
    }
    for (const { json, decoded } of wire.server_messages_with_unknown_fields) {
      expect(comparable(decodeServerText(JSON.stringify(json)))).toEqual(
        decoded,
      );
    }
  });

  test("W-44, W-47: what it ignores, what it refuses", () => {
    for (const { why, json } of wire.server_messages_ignored) {
      expect(decodeServerText(JSON.stringify(json)), why).toEqual({
        kind: "unknown",
      });
    }
    for (const { why, json } of wire.server_messages_malformed) {
      expect(() => decodeServerText(JSON.stringify(json)), why).toThrow();
    }
  });

  test("§1.7, W-46: frames", () => {
    for (const { channel, blob, frame } of wire.frames) {
      expect(toHex(encodeFrame(channel, fromHex(blob)))).toBe(frame);
      expect(comparable(decodeFrame(fromHex(frame)))).toEqual({
        channel,
        blob,
      });
    }
    for (const frame of wire.frames_of_unknown_channel) {
      expect(decodeFrame(fromHex(frame))).toBeUndefined();
    }
  });

  test("§1.9: close codes", () => {
    const codes = wire.close_codes;
    expect({
      malformed: CloseCode.Malformed,
      unauthenticated: CloseCode.Unauthenticated,
      forbidden: CloseCode.Forbidden,
      deleted: CloseCode.Deleted,
      too_slow: CloseCode.TooSlow,
      revoked: CloseCode.Revoked,
      unsupported_version: CloseCode.UnsupportedVersion,
      too_many_connections: CloseCode.TooManyConnections,
    }).toEqual(codes);
  });
});
