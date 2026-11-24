import { describe, expect, test } from "vitest";
import {
  CloseCode,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeHistoryReply,
  decodePublishAck,
  decodeServerText,
  encodeAuthMessage,
  encodeCompactMessage,
  encodeDeleteMessage,
  encodeExpireMessage,
  encodeFrame,
  encodeJoinMessage,
  encodeRotateMessage,
  mayCompact,
  mayDelete,
  mayPublish,
} from "./protocol.js";

describe("encodeJoinMessage", () => {
  test("matches the server's expected wire shape", () => {
    expect(JSON.parse(encodeJoinMessage("doc-123", "content"))).toEqual({
      join: "doc-123",
      channel: "content",
    });
  });

  test("encodes the requested channel, not always content", () => {
    expect(JSON.parse(encodeJoinMessage("doc-123", "annotations"))).toEqual({
      join: "doc-123",
      channel: "annotations",
    });
  });

  test("omits since when not given", () => {
    expect(
      JSON.parse(encodeJoinMessage("doc-123", "content")),
    ).not.toHaveProperty("since");
  });

  test("encodes since when given", () => {
    expect(JSON.parse(encodeJoinMessage("doc-123", "content", 42))).toEqual({
      join: "doc-123",
      channel: "content",
      since: 42,
    });
  });
});

describe("encodeFrame / decodeFrame", () => {
  test("a frame round-trips its channel and blob", () => {
    const blob = new Uint8Array([1, 2, 3, 4]);

    const frame = encodeFrame("content", blob);
    const decoded = decodeFrame(frame);

    expect(decoded?.channel).toBe("content");
    expect(decoded?.blob).toEqual(blob);
  });

  test("a frame round-trips the annotations channel and blob", () => {
    const blob = new Uint8Array([5, 6, 7]);

    const frame = encodeFrame("annotations", blob);
    const decoded = decodeFrame(frame);

    expect(decoded?.channel).toBe("annotations");
    expect(decoded?.blob).toEqual(blob);
  });

  test("content and annotations encode to distinct channel bytes", () => {
    const contentFrame = encodeFrame("content", new Uint8Array([0]));
    const annotationsFrame = encodeFrame("annotations", new Uint8Array([0]));

    expect(contentFrame[0]).not.toBe(annotationsFrame[0]);
  });

  test("the decisions channel is byte 2, like the server's ChannelId", () => {
    const frame = encodeFrame("decisions", new Uint8Array([9]));
    expect(frame[0]).toBe(2);
    expect(decodeFrame(frame)?.channel).toBe("decisions");
  });

  test("decoding an empty frame throws", () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow();
  });
});

describe("decodeHistoryReply", () => {
  test("decodes the server's base64 JSON history shape into blobs, with seq", () => {
    const json = JSON.stringify({
      history: [{ channel: "content", seq: 7, blob: "AAH/" }],
    });

    const entries = decodeHistoryReply(json);

    expect(entries).toEqual([
      { channel: "content", seq: 7, blob: new Uint8Array([0, 1, 255]) },
    ]);
  });

  test("decodes an empty history", () => {
    expect(decodeHistoryReply(JSON.stringify({ history: [] }))).toEqual([]);
  });

  test("throws on a reply with no history field", () => {
    expect(() => decodeHistoryReply(JSON.stringify({}))).toThrow();
  });

  test("throws on an entry with a wrong-typed field", () => {
    const json = JSON.stringify({
      history: [{ channel: "content", seq: "not-a-number", blob: "AAH/" }],
    });
    expect(() => decodeHistoryReply(json)).toThrow();
  });

  test("decodes an annotations-channel entry", () => {
    const json = JSON.stringify({
      history: [{ channel: "annotations", seq: 3, blob: "AAH/" }],
    });

    const entries = decodeHistoryReply(json);

    expect(entries).toEqual([
      { channel: "annotations", seq: 3, blob: new Uint8Array([0, 1, 255]) },
    ]);
  });
});

describe("decisions channel in JSON messages", () => {
  test("a history entry of the decisions channel decodes", () => {
    const [entry] = decodeHistoryReply(
      JSON.stringify({
        history: [{ channel: "decisions", seq: 4, blob: "AQ==" }],
      }),
    );
    expect(entry?.channel).toBe("decisions");
  });

  test("an ack of the decisions channel decodes", () => {
    expect(
      decodePublishAck(JSON.stringify({ ack: "decisions", seq: 5 })),
    ).toEqual({ channel: "decisions", seq: 5 });
  });
});

describe("encodeCompactMessage", () => {
  test("matches the server's expected wire shape", () => {
    const snapshot = new Uint8Array([0, 1, 255]);

    const message = JSON.parse(
      encodeCompactMessage("doc-123", "content", 1000, snapshot),
    );

    expect(message).toEqual({
      compact: "doc-123",
      channel: "content",
      up_to_seq: 1000,
      snapshot: "AAH/",
    });
  });

  test("encodes the requested channel, not always content", () => {
    const snapshot = new Uint8Array([0]);

    const message = JSON.parse(
      encodeCompactMessage("doc-123", "annotations", 1, snapshot),
    );

    expect(message.channel).toBe("annotations");
  });
});

describe("decodePublishAck", () => {
  test("decodes the server's ack shape", () => {
    const ack = decodePublishAck(JSON.stringify({ ack: "content", seq: 7 }));

    expect(ack).toEqual({ channel: "content", seq: 7 });
  });

  test("throws when seq is missing or wrong-typed", () => {
    expect(() =>
      decodePublishAck(JSON.stringify({ ack: "content" })),
    ).toThrow();
    expect(() =>
      decodePublishAck(JSON.stringify({ ack: "content", seq: "7" })),
    ).toThrow();
  });

  test("throws on an unknown channel", () => {
    expect(() =>
      decodePublishAck(JSON.stringify({ ack: "bogus", seq: 7 })),
    ).toThrow();
  });
});

describe("decodeServerText", () => {
  test("tells a history reply", () => {
    expect(decodeServerText(JSON.stringify({ history: [] }))).toEqual({
      kind: "history",
      entries: [],
    });
  });

  test("tells a publish ack", () => {
    expect(
      decodeServerText(JSON.stringify({ ack: "content", seq: 1 })),
    ).toEqual({ kind: "ack", channel: "content", seq: 1 });
  });

  test("tells an authentication and a rotation (ADR-0019)", () => {
    expect(
      decodeServerText(
        JSON.stringify({
          authenticated: "read",
          generation: 3,
          expires_at: null,
          v: 1,
        }),
      ),
    ).toEqual({
      kind: "authenticated",
      role: "read",
      generation: 3,
      expiresAt: null,
      version: 1,
    });
    expect(decodeServerText(JSON.stringify({ rotated: 4 }))).toEqual({
      kind: "rotated",
      generation: 4,
    });
  });

  // ADR-0023 §2: the expiry, at authentication and in the reply to the
  // editor who set it.
  test("tells the document's expiry", () => {
    expect(
      decodeServerText(
        JSON.stringify({
          authenticated: "edit",
          generation: 1,
          expires_at: 1_900_000_150,
          v: 1,
        }),
      ),
    ).toEqual({
      kind: "authenticated",
      role: "edit",
      generation: 1,
      expiresAt: 1_900_000_150,
      version: 1,
    });
    expect(decodeServerText(JSON.stringify({ expiry: 7 }))).toEqual({
      kind: "expiry",
      expiresAt: 7,
    });
    expect(decodeServerText(JSON.stringify({ expiry: null }))).toEqual({
      kind: "expiry",
      expiresAt: null,
    });
  });

  test("throws on a known message of the wrong shape, or two at once", () => {
    for (const json of [
      JSON.stringify({ expiry: "7" }),
      JSON.stringify({
        authenticated: "edit",
        generation: 1,
        expires_at: "7",
        v: 1,
      }),
      JSON.stringify("just a string"),
      JSON.stringify({ authenticated: "admin", generation: 1, v: 1 }),
      JSON.stringify({ authenticated: "edit", v: 1 }),
      JSON.stringify({ authenticated: "edit", generation: 1 }),
      JSON.stringify({ authenticated: "edit", generation: 1, v: "1" }),
      // W-8: `expires_at` is part of the reply, `null` when none.
      JSON.stringify({ authenticated: "read", generation: 3, v: 1 }),
      JSON.stringify({ rotated: "4" }),
      JSON.stringify({ ack: "content", seq: 1, rotated: 4 }),
    ]) {
      expect(() => decodeServerText(json), json).toThrow();
    }
  });

  // docs/phase-8-protocole-ouvert.md, N4: a server of a later minor
  // extension may send what this client doesn't know. Never an ack: a
  // message is one only under its own key.
  test("tells a message it doesn't know, and never takes it for an ack", () => {
    for (const json of [
      JSON.stringify({}),
      JSON.stringify({ notice: "hello" }),
      JSON.stringify({ channel: "content", seq: 1 }),
      JSON.stringify({ receipt: "content", channel: "content", seq: 1 }),
      JSON.stringify({ expires_at: 7 }),
    ]) {
      expect(decodeServerText(json), json).toEqual({ kind: "unknown" });
    }
  });

  test("ignores the fields it doesn't know", () => {
    expect(
      decodeServerText(JSON.stringify({ ack: "content", seq: 1, at: 5 })),
    ).toEqual({ kind: "ack", channel: "content", seq: 1 });
    expect(
      decodeServerText(JSON.stringify({ rotated: 4, by: "someone" })),
    ).toEqual({ kind: "rotated", generation: 4 });
    expect(
      decodeServerText(
        JSON.stringify({
          history: [{ channel: "content", seq: 1, blob: "AQ==", at: 5 }],
          more: true,
        }),
      ),
    ).toMatchObject({ kind: "history", entries: [{ seq: 1 }] });
  });

  test("skips a history entry of a channel it doesn't know", () => {
    expect(
      decodeServerText(
        JSON.stringify({
          history: [
            { channel: "comments", seq: 1, blob: 5 },
            { channel: "content", seq: 2, blob: "AQ==" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "history", entries: [{ seq: 2 }] });
  });
});

describe("decodeFrame of an unknown channel", () => {
  test("tells a channel it doesn't know, and throws on an empty frame", () => {
    expect(decodeFrame(new Uint8Array([9, 1, 2]))).toBeUndefined();
    expect(() => decodeFrame(new Uint8Array([]))).toThrow();
  });
});

describe("encodeAuthMessage", () => {
  test("matches the server's expected wire shape, secret in base64url", () => {
    const secret = new Uint8Array(32).fill(0xfb);

    expect(JSON.parse(encodeAuthMessage("doc-1", "suggest", secret))).toEqual({
      auth: "doc-1",
      v: PROTOCOL_VERSION,
      role: "suggest",
      secret: btoaUrl(secret),
    });
  });
});

describe("encodeRotateMessage", () => {
  test("matches the server's expected wire shape", () => {
    const bytes = (n: number) => new Uint8Array(32).fill(n);

    expect(
      JSON.parse(
        encodeRotateMessage({
          read: bytes(1),
          suggest: bytes(2),
          edit: bytes(3),
        }),
      ),
    ).toEqual({
      rotate: {
        read: btoaUrl(bytes(1)),
        suggest: btoaUrl(bytes(2)),
        edit: btoaUrl(bytes(3)),
      },
    });
  });
});

describe("deletion and expiry (ADR-0023)", () => {
  test("match the server's expected wire shapes", () => {
    expect(JSON.parse(encodeDeleteMessage("doc-1"))).toEqual({
      delete: "doc-1",
    });
    expect(JSON.parse(encodeExpireMessage("doc-1", 3600))).toEqual({
      expire: "doc-1",
      in: 3600,
    });
    expect(JSON.parse(encodeExpireMessage("doc-1", null))).toEqual({
      expire: "doc-1",
      in: null,
    });
  });

  test("4404 says the document was deleted, and only editors delete", () => {
    expect(CloseCode.Deleted).toBe(4404);
    expect([
      mayDelete("read"),
      mayDelete("suggest"),
      mayDelete("edit"),
    ]).toEqual([false, false, true]);
  });
});

describe("close codes", () => {
  test("4426: another protocol version", () => {
    expect(CloseCode.UnsupportedVersion).toBe(4426);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("rights (ADR-0019 §1)", () => {
  test("mirror the server's table", () => {
    const channels = ["content", "annotations", "decisions"] as const;
    const allowed = (role: "read" | "suggest" | "edit") =>
      channels.filter((channel) => mayPublish(role, channel));

    expect(allowed("read")).toEqual([]);
    expect(allowed("suggest")).toEqual(["annotations"]);
    expect(allowed("edit")).toEqual([...channels]);
    expect([
      mayCompact("read"),
      mayCompact("suggest"),
      mayCompact("edit"),
    ]).toEqual([false, false, true]);
  });
});

function btoaUrl(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
