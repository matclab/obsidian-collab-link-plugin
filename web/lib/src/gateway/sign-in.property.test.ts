// What another page of the origin, or the gateway, can bring to the page
// (docs/protocol/06-identity.md, ID-20, ID-21, ID-25, ID-41;
// docs/security/untrusted-inputs.md, C18): a return is one of the two
// forms, read back as itself, or nothing; a session answer is a session
// or an Error — never an exception of another kind.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import {
  readGatewaySession,
  readObsidianReturn,
  readSignInMessage,
  readSignInReturn,
} from "./sign-in.js";

type TC = Parameters<Parameters<typeof hegel.test>[0]>[0];

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A value close to a valid one, or anything. */
function field(tc: TC, valid: string): string {
  return tc.draw(
    gs.sampledFrom([
      valid,
      valid,
      valid.slice(1),
      `${valid}=`,
      valid.toUpperCase(),
      `%${valid}`,
      tc.draw(gs.text({ maxSize: 50 })),
    ]),
  );
}

function hostileHash(tc: TC): string {
  const request = hex(
    new Uint8Array(tc.draw(gs.binary({ minSize: 16, maxSize: 16 }))),
  );
  const code = bytesToBase64Url(
    new Uint8Array(tc.draw(gs.binary({ minSize: 32, maxSize: 32 }))),
  );
  const parts = tc.draw(
    gs.arrays(gs.sampledFrom(["request", "code", "error", "x", ""]), {
      maxSize: 4,
    }),
  );
  const text = parts
    .map((name) => {
      const value =
        name === "request"
          ? field(tc, request)
          : name === "code"
            ? field(tc, code)
            : field(tc, tc.draw(gs.sampledFrom(["denied", "failed", "other"])));
      return tc.draw(gs.booleans()) ? `${name}=${value}` : name;
    })
    .join("&");
  return tc.draw(gs.sampledFrom(["#", "#", "?", ""])) + text;
}

describe("the return of a sign-in (C18)", () => {
  test("a fragment is one of the two forms, or nothing", () =>
    hegel.test((tc) => {
      const hash = hostileHash(tc);
      const read = readSignInReturn(hash);
      if (read === undefined) return;
      expect(read.request).toMatch(/^[0-9a-f]{32}$/);
      if ("code" in read) {
        expect(Object.keys(read).sort()).toEqual(["code", "request"]);
        expect(read.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // Read back as itself, from the fragment and from the channel.
        expect(
          readSignInReturn(`#code=${read.code}&request=${read.request}`),
        ).toEqual(read);
      } else {
        expect(["denied", "failed"]).toContain(read.error);
      }
      expect(readSignInMessage({ ...read })).toEqual(read);
    }));

  test("a message is one of the two forms, or nothing", () =>
    hegel.test((tc) => {
      const message = tc.draw(
        gs.oneOf<unknown>(
          gs.just(null),
          gs.text({ maxSize: 20 }),
          gs.integers(),
          gs
            .maps(
              gs.sampledFrom(["request", "code", "error", "x"]),
              gs.oneOf<unknown>(
                gs.text({ maxSize: 50 }),
                gs.integers(),
                gs.just(null),
              ),
              { maxSize: 4 },
            )
            .map((map) => Object.fromEntries(map)),
        ),
      );
      const read = readSignInMessage(message);
      if (read !== undefined) {
        expect(read.request).toMatch(/^[0-9a-f]{32}$/);
      }
    }));
});

describe("the return by obsidian:// (C18, ID-41)", () => {
  test("a handler's parameters are one of the two forms, or nothing", () =>
    hegel.test((tc) => {
      const request = hex(
        new Uint8Array(tc.draw(gs.binary({ minSize: 16, maxSize: 16 }))),
      );
      const code = bytesToBase64Url(
        new Uint8Array(tc.draw(gs.binary({ minSize: 32, maxSize: 32 }))),
      );
      // A valid return, then up to two flaws: a field dropped, one added,
      // one altered — the returns a forger would try first.
      const params: Record<string, unknown> = tc.draw(gs.booleans())
        ? { action: "collab-link-auth", code, request }
        : { action: "collab-link-auth", error: "denied", request };
      const flaws = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
      for (let flaw = 0; flaw < flaws; flaw++) {
        const name = tc.draw(
          gs.sampledFrom(["action", "request", "code", "error", "hash", "x"]),
        );
        switch (tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))) {
          case 0:
            delete params[name];
            break;
          case 1:
            params[name] = field(
              tc,
              typeof params[name] === "string" ? params[name] : "",
            );
            break;
          default:
            params[name] = tc.draw(
              gs.oneOf<unknown>(gs.integers(), gs.just(null), gs.just("")),
            );
        }
      }
      const read = readObsidianReturn(params);
      if (read === undefined) return;
      expect(params.action).toBe("collab-link-auth");
      expect("hash" in params).toBe(false);
      expect(read.request).toBe(params.request);
      if ("code" in read) {
        expect(read.code).toBe(params.code);
        expect("error" in params).toBe(false);
      } else {
        expect(["denied", "failed"]).toContain(read.error);
        expect("code" in params).toBe(false);
      }
      // As the page's channel reads it.
      expect(readSignInMessage({ ...read })).toEqual(read);
    }));
});

describe("a session answer (C18)", () => {
  test("is a session or an Error", () =>
    hegel.test((tc) => {
      const token = bytesToBase64Url(
        new Uint8Array(tc.draw(gs.binary({ minSize: 32, maxSize: 32 }))),
      );
      const anything = gs.oneOf<unknown>(
        gs.text({ maxSize: 20 }),
        gs.integers(),
        gs.just(null),
        gs.booleans(),
      );
      const value: Record<string, unknown> = {};
      for (const [name, valid] of [
        ["token", token],
        ["expires_at", tc.draw(gs.integers({ minValue: 0 }))],
        ["name", tc.draw(gs.text({ maxSize: 20 }))],
        ["email", tc.draw(gs.oneOf(gs.text({ maxSize: 20 }), gs.just(null)))],
        ["issuer", tc.draw(gs.text({ maxSize: 20 }))],
        ["sub", tc.draw(gs.text({ maxSize: 20 }))],
      ] as const) {
        switch (tc.draw(gs.integers({ minValue: 0, maxValue: 5 }))) {
          case 0:
            break;
          case 1:
            value[name] = tc.draw(anything);
            break;
          default:
            value[name] = valid;
        }
      }
      let session: ReturnType<typeof readGatewaySession>;
      try {
        session = readGatewaySession(value);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return;
      }
      expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Number.isSafeInteger(session.expiresAt)).toBe(true);
      expect(typeof session.issuer).toBe("string");
      expect(typeof session.sub).toBe("string");
    }));
});
