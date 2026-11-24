// The keyring's HTTP transport (docs/protocol/05-keyring.md, §5.3) against
// a fake `fetch`: what it sends (headers, body, never K_t), and how it reads
// the server's answers.
import { describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../crypto/role-secrets.js";
import { formatKeyringLink, keyringVerifier } from "./crypto.js";
import {
  createKeyring,
  deleteKeyring,
  depositPairing,
  httpKeyringTransport,
  takePairing,
} from "./http.js";

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

describe("the keyring over HTTP", () => {
  test("KR-5: creating sends the verifier only, and gives a keyring link", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { calls, fetchFn } = fakeFetch(() =>
      Response.json({ keyring_id: id }, { headers: { etag: '"0"' } }),
    );
    const created = await createKeyring("https://collab.example.org", fetchFn);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://collab.example.org/keyrings");
    expect(call.init.method).toBe("POST");
    expect(header(call, "content-type")).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual({
      v: 1,
      verifier: bytesToBase64Url(await keyringVerifier(created.secret)),
    });
    // KR-17: neither K_t nor S leave.
    expect(call.init.body).not.toContain(bytesToBase64Url(created.key));
    expect(call.init.body).not.toContain(bytesToBase64Url(created.secret));
    expect(created.keyringId).toBe(id);
    expect(created.link).toBe(formatKeyringLink(created));
  });

  test("KR-6, KR-7: reads and writes, with the secret and the version", async () => {
    const secret = new Uint8Array(32).fill(5);
    const credentials = {
      keyringId: "ab".repeat(16),
      secret,
      key: new Uint8Array(32),
    };
    const answers = [
      new Response(new Uint8Array([1, 2, 3]), { headers: { etag: '"7"' } }),
      new Response(null, { status: 204, headers: { etag: '"8"' } }),
      new Response(null, { status: 412, headers: { etag: '"9"' } }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ];
    const { calls, fetchFn } = fakeFetch(() => answers.shift() as Response);
    const transport = httpKeyringTransport("https://h", credentials, fetchFn);

    expect(await transport.read()).toEqual({
      version: 7,
      blob: new Uint8Array([1, 2, 3]),
    });
    expect(await transport.write(7, new Uint8Array([4]))).toEqual({
      written: 8,
    });
    expect(await transport.write(7, new Uint8Array([4]))).toEqual({ stale: 9 });
    expect(await transport.read()).toBe("missing");
    expect(await transport.write(9, new Uint8Array([4]))).toBe("missing");

    for (const call of calls) {
      expect(call.url).toBe(`https://h/keyrings/${"ab".repeat(16)}`);
      expect(header(call, "keyring-secret")).toBe(bytesToBase64Url(secret));
    }
    expect((calls[1] as Call).init.method).toBe("PUT");
    expect(header(calls[1] as Call, "if-match")).toBe('"7"');
    expect(header(calls[1] as Call, "content-type")).toBe(
      "application/octet-stream",
    );
  });

  test("an answer it doesn't know rejects: nothing is guessed", async () => {
    const credentials = {
      keyringId: "ab".repeat(16),
      secret: new Uint8Array(32),
      key: new Uint8Array(32),
    };
    for (const response of [
      new Response(null, { status: 500 }),
      new Response(new Uint8Array([1]), { headers: { etag: 'W/"1"' } }),
      new Response(new Uint8Array([1])),
    ]) {
      const transport = httpKeyringTransport(
        "https://h",
        credentials,
        async () => response,
      );
      await expect(transport.read()).rejects.toThrow();
    }
  });

  test("KR-10, KR-29: deleting, with the secret; already gone is no error", async () => {
    const secret = new Uint8Array(32).fill(6);
    const credentials = {
      keyringId: "cd".repeat(16),
      secret,
      key: new Uint8Array(32),
    };
    const answers = [
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 500 }),
    ];
    const { calls, fetchFn } = fakeFetch(() => answers.shift() as Response);
    expect(await deleteKeyring("https://h", credentials, fetchFn)).toBe(
      "deleted",
    );
    expect(await deleteKeyring("https://h", credentials, fetchFn)).toBe(
      "missing",
    );
    await expect(
      deleteKeyring("https://h", credentials, fetchFn),
    ).rejects.toThrow();
    const call = calls[0] as Call;
    expect(call.url).toBe(`https://h/keyrings/${"cd".repeat(16)}`);
    expect(call.init.method).toBe("DELETE");
    expect(header(call, "keyring-secret")).toBe(bytesToBase64Url(secret));
  });

  test("KR-31: a deposit goes with the secret, as bytes; its id comes back", async () => {
    const secret = new Uint8Array(32).fill(8);
    const credentials = {
      keyringId: "ef".repeat(16),
      secret,
      key: new Uint8Array(32).fill(9),
    };
    const pairingId = "12".repeat(16);
    const answers = [
      Response.json({ pairing_id: pairingId }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 429 }),
      Response.json({ pairing_id: "not an id" }),
      new Response(null, { status: 500 }),
    ];
    const { calls, fetchFn } = fakeFetch(() => answers.shift() as Response);
    const deposit = new Uint8Array([1, 2, 3]);
    expect(
      await depositPairing("https://h", credentials, deposit, fetchFn),
    ).toEqual({ pairingId });
    expect(
      await depositPairing("https://h", credentials, deposit, fetchFn),
    ).toBe("missing");
    expect(
      await depositPairing("https://h", credentials, deposit, fetchFn),
    ).toBe("too-many");
    for (let n = 0; n < 2; n++) {
      await expect(
        depositPairing("https://h", credentials, deposit, fetchFn),
      ).rejects.toThrow();
    }
    const call = calls[0] as Call;
    expect(call.url).toBe(`https://h/keyrings/${"ef".repeat(16)}/pairings`);
    expect(call.init.method).toBe("POST");
    expect(header(call, "keyring-secret")).toBe(bytesToBase64Url(secret));
    expect(header(call, "content-type")).toBe("application/octet-stream");
    expect(call.init.body).toBe(deposit);
  });

  test("KR-32: taking a deposit, once; not found is `missing`", async () => {
    const pairingId = "34".repeat(16);
    const answers = [
      new Response(new Uint8Array([7, 8]), { status: 200 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 403 }),
    ];
    const { calls, fetchFn } = fakeFetch(() => answers.shift() as Response);
    expect(await takePairing("https://h", pairingId, fetchFn)).toEqual(
      new Uint8Array([7, 8]),
    );
    expect(await takePairing("https://h", pairingId, fetchFn)).toBe("missing");
    await expect(
      takePairing("https://h", pairingId, fetchFn),
    ).rejects.toThrow();
    const call = calls[0] as Call;
    expect(call.url).toBe(`https://h/pairings/${pairingId}/take`);
    expect(call.init.method).toBe("POST");
    // Nothing but the id: no secret of any kind.
    expect(call.init.body).toBeUndefined();
    expect(call.init.headers).toBeUndefined();
  });
});
