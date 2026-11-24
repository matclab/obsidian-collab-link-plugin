// The keyring of an account over HTTP (docs/protocol/05-keyring.md,
// §5.12) against a fake `fetch`: the token read at each request, never
// `K_t`; `401` is `SignedOut` (TR6), whatever the request.
import { describe, expect, test } from "vitest";
import {
  SignedOut,
  depositAccountPairing,
  httpAccountKeyringTransport,
  takeAccountPairing,
} from "./account.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetchFn };
}

const header = (call: Call, name: string) =>
  new Headers(call.init.headers).get(name);
const GATEWAY = "https://gateway.example.org";
const ID = "0123456789abcdef0123456789abcdef";

describe("the keyring of an account over HTTP", () => {
  test("KR-39: read and write with the token of the moment", async () => {
    let token = "first";
    const { calls, fetchFn } = fakeFetch((call) =>
      call.init.method === "PUT"
        ? new Response(null, { status: 204, headers: { etag: '"4"' } })
        : new Response(new Uint8Array([1, 2]), { headers: { etag: '"3"' } }),
    );
    const transport = httpAccountKeyringTransport(
      GATEWAY,
      async () => token,
      fetchFn,
    );
    expect(await transport.read()).toEqual({
      version: 3,
      blob: new Uint8Array([1, 2]),
    });
    token = "second";
    expect(await transport.write(3, new Uint8Array([9]))).toEqual({
      written: 4,
    });
    expect(calls.map((c) => c.url)).toEqual([
      `${GATEWAY}/accounts/keyring`,
      `${GATEWAY}/accounts/keyring`,
    ]);
    expect(calls.map((c) => header(c, "authorization"))).toEqual([
      "Bearer first",
      "Bearer second",
    ]);
    const put = calls[1] as Call;
    expect(header(put, "if-match")).toBe('"3"');
    expect(header(put, "content-type")).toBe("application/octet-stream");
    expect(header(put, "keyring-secret")).toBeNull();
  });

  test("KR-7: a stale write gives the current version", async () => {
    const { fetchFn } = fakeFetch(
      () => new Response(null, { status: 412, headers: { etag: '"8"' } }),
    );
    const transport = httpAccountKeyringTransport(
      GATEWAY,
      async () => "t",
      fetchFn,
    );
    expect(await transport.write(3, new Uint8Array([9]))).toEqual({ stale: 8 });
  });

  test("TR6: no token, or `401`, is SignedOut — never a request without one", async () => {
    const { calls, fetchFn } = fakeFetch(
      () => new Response(null, { status: 401 }),
    );
    const none = httpAccountKeyringTransport(
      GATEWAY,
      async () => undefined,
      fetchFn,
    );
    await expect(none.read()).rejects.toBeInstanceOf(SignedOut);
    await expect(none.write(0, new Uint8Array([1]))).rejects.toBeInstanceOf(
      SignedOut,
    );
    expect(calls).toHaveLength(0);
    const refused = httpAccountKeyringTransport(
      GATEWAY,
      async () => "t",
      fetchFn,
    );
    await expect(refused.read()).rejects.toBeInstanceOf(SignedOut);
    await expect(refused.write(0, new Uint8Array([1]))).rejects.toBeInstanceOf(
      SignedOut,
    );
    await expect(
      depositAccountPairing(
        GATEWAY,
        async () => "t",
        new Uint8Array([1]),
        fetchFn,
      ),
    ).rejects.toBeInstanceOf(SignedOut);
    await expect(
      takeAccountPairing(GATEWAY, async () => "t", ID, fetchFn),
    ).rejects.toBeInstanceOf(SignedOut);
  });

  test("KR-41: a deposit and its take", async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.url.endsWith("/take")
        ? new Response(new Uint8Array([7]))
        : Response.json({ pairing_id: ID }),
    );
    expect(
      await depositAccountPairing(
        GATEWAY,
        async () => "t",
        new Uint8Array([5]),
        fetchFn,
      ),
    ).toEqual({ pairingId: ID });
    expect(
      await takeAccountPairing(GATEWAY, async () => "t", ID, fetchFn),
    ).toEqual(new Uint8Array([7]));
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", `${GATEWAY}/accounts/keyring/pairings`],
      ["POST", `${GATEWAY}/accounts/pairings/${ID}/take`],
    ]);
    const { fetchFn: gone } = fakeFetch(
      () => new Response(null, { status: 404 }),
    );
    expect(await takeAccountPairing(GATEWAY, async () => "t", ID, gone)).toBe(
      "missing",
    );
    const { fetchFn: full } = fakeFetch(
      () => new Response(null, { status: 429 }),
    );
    expect(
      await depositAccountPairing(
        GATEWAY,
        async () => "t",
        new Uint8Array([5]),
        full,
      ),
    ).toBe("too-many");
  });
});
