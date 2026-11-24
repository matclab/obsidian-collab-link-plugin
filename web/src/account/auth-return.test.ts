// The page of `/auth-return` (ADR-0041, points 1 and 4; docs/protocol/
// 06-identity.md, ID-25): the fragment erased before anything else, a
// return of the right form passed to the tabs and the window closed;
// anything else passed to no one.
import { describe, expect, test } from "vitest";
import { vectors } from "../../lib/src/test-support/vectors.js";
import { forwardSignInReturn } from "./auth-return.js";
import { SIGN_IN_CHANNEL } from "./channels.js";

function page(hash: string) {
  const events: string[] = [];
  const posted: { name: string; data: unknown }[] = [];
  return {
    events,
    posted,
    page: {
      hash,
      pathname: "/auth-return",
      replaceAddress: (url: string) => events.push(`address ${url}`),
      post: (name: string, data: unknown) => {
        events.push("post");
        posted.push({ name, data });
      },
      close: () => events.push("close"),
      say: (text: string) => events.push(`say ${text}`),
    },
  };
}

const gateway = vectors.identity.gateway;

describe("the page of /auth-return", () => {
  test("a return is passed to the tabs, the fragment erased first, then the window closed", () => {
    for (const { hash, expected } of gateway.returns) {
      const { page: returnPage, events, posted } = page(hash);
      expect(forwardSignInReturn(returnPage)).toBe(true);
      expect(posted).toEqual([{ name: SIGN_IN_CHANNEL, data: expected }]);
      expect(events[0]).toBe("address /auth-return");
      expect(events.indexOf("post")).toBeLessThan(events.indexOf("close"));
    }
  });

  test("anything else is passed to no one, and its fragment erased", () => {
    for (const { why, hash } of gateway.returns_refused) {
      const { page: returnPage, events, posted } = page(hash);
      expect(forwardSignInReturn(returnPage), why).toBe(false);
      expect(posted, why).toEqual([]);
      expect(events.includes("close"), why).toBe(false);
      if (hash.startsWith("#")) {
        expect(events[0], why).toBe("address /auth-return");
      }
    }
  });
});
