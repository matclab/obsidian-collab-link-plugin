// Signing in with a gateway (docs/protocol/06-identity.md, §6.7): the
// forms against the specification's vectors (identity.gateway), and what
// the requests to the gateway look like.
import { describe, expect, test, vi } from "vitest";
import { vectors } from "../test-support/vectors.js";
import {
  challengeOf,
  endGatewaySession,
  exchangeSignInCode,
  gatewayHealthy,
  newSignInAttempt,
  readGatewaySession,
  readObsidianReturn,
  readSignInMessage,
  readSignInReturn,
  signInAddress,
} from "./sign-in.js";

const gateway = vectors.identity.gateway;

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
  });
}

describe("ID-19: the attempt and its window", () => {
  test("the challenge is SHA-256 of the verifier's bytes", async () => {
    expect(await challengeOf(gateway.verifier)).toBe(gateway.challenge);
  });

  test("an attempt's forms are those the gateway accepts", async () => {
    const attempt = await newSignInAttempt();
    expect(attempt.request).toMatch(/^[0-9a-f]{32}$/);
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.challenge).toBe(await challengeOf(attempt.verifier));
    const other = await newSignInAttempt();
    expect(other.request).not.toBe(attempt.request);
    expect(other.verifier).not.toBe(attempt.verifier);
  });

  test("the address carries the request and the challenge, and nothing else", () => {
    const [query] = gateway.login_queries;
    const address = new URL(
      signInAddress("https://accounts.example/", {
        request: query.request,
        verifier: gateway.verifier,
        challenge: query.challenge,
      }),
    );
    expect(address.origin + address.pathname).toBe(
      "https://accounts.example/accounts/login",
    );
    expect([...address.searchParams]).toEqual([
      ["request", query.request],
      ["challenge", query.challenge],
    ]);
    expect(address.hash).toBe("");
  });

  test("ID-41: the plugin's address asks for its return by obsidian://", () => {
    const [query] = gateway.login_queries;
    const attempt = {
      request: query.request,
      verifier: gateway.verifier,
      challenge: query.challenge,
    };
    for (const fresh of [false, true]) {
      const address = signInAddress("https://accounts.example", attempt, {
        fresh,
        client: "obsidian",
      });
      const raw = new URL(address).search.slice(1);
      expect(
        raw.split("&").filter((part) => part.startsWith("client")),
      ).toEqual(["client=obsidian"]);
      expect(raw.split("&").includes("fresh")).toBe(fresh);
    }
  });
});

describe("ID-41: the return by obsidian://", () => {
  test("the vectors' returns read as expected", () => {
    for (const { params, expected } of gateway.obsidian_returns) {
      expect(readObsidianReturn(params), JSON.stringify(params)).toEqual(
        expected,
      );
    }
  });

  test("the vectors' refused returns are no return", () => {
    for (const { why, params } of gateway.obsidian_returns_refused) {
      expect(readObsidianReturn(params), why).toBeUndefined();
    }
  });
});

describe("ID-20, ID-25: the return", () => {
  test("the vectors' returns read as expected", () => {
    for (const { hash, expected } of gateway.returns) {
      expect(readSignInReturn(hash), hash).toEqual(expected);
    }
  });

  test("the vectors' refused returns are no return", () => {
    for (const { why, hash } of gateway.returns_refused) {
      expect(readSignInReturn(hash), why).toBeUndefined();
    }
  });

  test("the channel's message reads as the fragment does", () => {
    for (const { expected } of gateway.returns) {
      const message =
        "code" in expected
          ? { request: expected.request, code: expected.code }
          : { request: expected.request, error: expected.error };
      expect(readSignInMessage(message)).toEqual(expected);
    }
    const [{ expected }] = gateway.returns;
    for (const hostile of [
      null,
      "text",
      [expected.request, expected.code],
      { ...expected, more: "x" },
      { request: expected.request, code: 7 },
      { request: expected.request },
    ]) {
      expect(readSignInMessage(hostile), JSON.stringify(hostile)).toBe(
        undefined,
      );
    }
  });
});

describe("ID-21, ID-24: the exchange", () => {
  test("the vectors' sessions read as expected; a field unknown is ignored", () => {
    for (const { json, expected } of gateway.sessions) {
      const { expires_at, ...rest } = expected;
      expect(readGatewaySession(json)).toEqual({
        ...rest,
        expiresAt: expires_at,
      });
    }
  });

  test("the vectors' refused sessions are errors", () => {
    for (const { why, json } of gateway.sessions_refused) {
      expect(() => readGatewaySession(json), why).toThrow(Error);
    }
  });

  test("the code goes with the attempt's verifier, as JSON", async () => {
    const [{ json }] = gateway.sessions;
    const fetch = vi.fn(async () => answer(200, json));
    const attempt = await newSignInAttempt();
    const session = await exchangeSignInCode(
      "https://accounts.example",
      "the-code",
      attempt,
      fetch,
    );
    expect(session).toMatchObject({ token: json.token, sub: json.sub });
    expect(fetch).toHaveBeenCalledWith(
      "https://accounts.example/accounts/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "the-code", verifier: attempt.verifier }),
      },
    );
  });

  test("401 is a refusal; another status or a malformed answer rejects", async () => {
    const attempt = await newSignInAttempt();
    const exchange = (response: Response) =>
      exchangeSignInCode(
        "https://g.example",
        "c",
        attempt,
        async () => response,
      );
    expect(await exchange(answer(401))).toBe("refused");
    await expect(exchange(answer(500))).rejects.toThrow(Error);
    await expect(exchange(answer(200, { token: "x" }))).rejects.toThrow(Error);
  });
});

describe("ID-22: logout and health", () => {
  test("logout carries the token; 204 and 401 both mean it is over", async () => {
    const fetch = vi.fn(async () => answer(204));
    await endGatewaySession("https://g.example", "T", fetch);
    expect(fetch).toHaveBeenCalledWith("https://g.example/accounts/logout", {
      method: "POST",
      headers: { Authorization: "Bearer T" },
    });
    await endGatewaySession("https://g.example", "T", async () => answer(401));
    await expect(
      endGatewaySession("https://g.example", "T", async () => answer(503)),
    ).rejects.toThrow(Error);
  });

  test("healthy only on 200 within the delay, and the late request aborted", async () => {
    let fire = () => {};
    const setTimer = (run: () => void) => {
      fire = run;
      return () => {
        fire = () => {};
      };
    };
    expect(
      await gatewayHealthy("https://g.example", {
        fetch: async () => answer(200, {}),
        setTimer,
      }),
    ).toBe(true);
    expect(
      await gatewayHealthy("https://g.example", {
        fetch: async () => answer(502),
        setTimer,
      }),
    ).toBe(false);
    expect(
      await gatewayHealthy("https://g.example", {
        fetch: async () => {
          throw new TypeError("offline");
        },
        setTimer,
      }),
    ).toBe(false);

    let signal: AbortSignal | undefined;
    const slow = gatewayHealthy("https://g.example", {
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      },
      setTimer,
      ms: 3000,
    });
    fire();
    expect(await slow).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});
