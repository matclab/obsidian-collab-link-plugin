import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test, vi } from "vitest";
import { formatLinkFragment, parseLinkFragment } from "./link-fragment.js";
import { ROLES, type Role, bytesToBase64Url } from "./role-secrets.js";

const secret = new Uint8Array(32).fill(7);
const encoded = bytesToBase64Url(secret);
/** A content key: 32 bytes (K-4). */
const KEY = bytesToBase64Url(new Uint8Array(32).fill(3));

describe("link fragment (ADR-0019 §2)", () => {
  test("reads the key, the role and its secret", () => {
    expect(parseLinkFragment(`#k=${KEY}&r=suggest.${encoded}`)).toEqual({
      key: KEY,
      role: "suggest",
      secret,
    });
  });

  test("round-trips any key, role and secret", () =>
    hegel.test((tc) => {
      const link = {
        key: bytesToBase64Url(
          new Uint8Array(tc.draw(gs.binary({ minSize: 32, maxSize: 32 }))),
        ),
        role: tc.draw(gs.sampledFrom([...ROLES])) as Role,
        secret: new Uint8Array(
          tc.draw(gs.binary({ minSize: 32, maxSize: 32 })),
        ),
      };
      const parsed = parseLinkFragment(formatLinkFragment(link));
      if (JSON.stringify(parsed) !== JSON.stringify(link)) {
        throw new Error(`${JSON.stringify(parsed)} != ${JSON.stringify(link)}`);
      }
    }));

  test.each([
    ["no '#'", `k=${KEY}&r=edit.${encoded}`],
    ["an empty fragment", "#"],
    ["a key alone, as before phase 5", "#abc123"],
    ["no role", `#k=${KEY}`],
    ["no key", `#r=edit.${encoded}`],
    ["an empty key", `#k=&r=edit.${encoded}`],
    ["an unknown role", `#k=${KEY}&r=admin.${encoded}`],
    ["a role without a secret", `#k=${KEY}&r=edit`],
    ["a short secret", `#k=${KEY}&r=edit.${bytesToBase64Url(secret.slice(1))}`],
    ["a secret that isn't base64url", `#k=${KEY}&r=edit.a+b/c=`],
    ["a key of 16 bytes", `#k=${KEY.slice(0, 22)}&r=edit.${encoded}`],
    [
      "a key of 33 bytes",
      `#k=${bytesToBase64Url(new Uint8Array(33))}&r=edit.${encoded}`,
    ],
  ])("refuses %s", (_, fragment) => {
    expect(() => parseLinkFragment(fragment)).toThrow();
  });

  test("never touches the network", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch must never be called");
    });
    const WebSocketSpy = vi.fn(() => {
      throw new Error("WebSocket must never be constructed");
    });
    vi.stubGlobal("WebSocket", WebSocketSpy);

    parseLinkFragment(`#k=${KEY}&r=edit.${encoded}`);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(WebSocketSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
