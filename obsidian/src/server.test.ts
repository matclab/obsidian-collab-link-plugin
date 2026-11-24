// The server documents are created on (docs/phase-14-plugin-obsidian.md,
// decisions 9 and 18): an address in the settings, over https or to this
// computer; Obsidian's `requestUrl` (a fetch from app://obsidian.md would
// meet CORS); a name and password, if set, sent with the creation only.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { RequestUrlParam } from "obsidian";
import { describe, expect, test } from "vitest";
import { createDocument } from "../../web/lib/src/index.js";
import {
  checkCredentials,
  creationFetch,
  requestFetch,
  serverOrigin,
} from "./server.js";

/** Obsidian's `requestUrl`, answering `status` with `body`. */
function request(status: number, body: unknown) {
  const sent: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    throw?: boolean;
  }[] = [];
  return {
    sent,
    requestUrl: async (param: (typeof sent)[number]) => {
      sent.push(param);
      const text = JSON.stringify(body);
      return {
        status,
        headers: {},
        text,
        json: body,
        arrayBuffer: new ArrayBuffer(0),
      };
    },
  };
}

describe("the server's address", () => {
  test("over https, any server; its origin", () => {
    expect(serverOrigin(" https://collab.example.org/ ")).toEqual({
      ok: true,
      origin: "https://collab.example.org",
    });
    expect(serverOrigin("https://collab.example.org:8443/x")).toEqual({
      ok: true,
      origin: "https://collab.example.org:8443",
    });
  });

  test("over plain http, only this computer", () => {
    expect(serverOrigin("http://localhost:8080").ok).toBe(true);
    expect(serverOrigin("http://127.0.0.1:8080").ok).toBe(true);
    hegel.test(
      (tc) => {
        const host = tc.draw(gs.domains());
        if (host === "localhost") return;
        expect(serverOrigin(`http://${host}/`)).toEqual({
          ok: false,
          problem: "insecure",
        });
      },
      { testCases: 100 },
    );
  });

  test("anything else is no server", () => {
    for (const text of ["", "collab.example.org", "ftp://x.org", "not a url"]) {
      expect(serverOrigin(text)).toEqual({
        ok: false,
        problem: "not-a-server",
      });
    }
  });
});

describe("creating a document through Obsidian", () => {
  test("goes through requestUrl, with the name and password when set", async () => {
    const { sent, requestUrl } = request(200, { document_id: "doc" });

    const created = await createDocument(
      "https://collab.test",
      creationFetch(requestUrl, { user: "alice", password: "pässword" }),
    );

    expect(created.documentId).toBe("doc");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://collab.test/documents");
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.throw).toBe(false);
    const auth = sent[0]?.headers?.Authorization ?? "";
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(auth.replace(/^Basic /, "")), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(decoded).toBe("alice:pässword");
  });

  test("without a name, sends none", async () => {
    const { sent, requestUrl } = request(200, { document_id: "doc" });
    await createDocument(
      "https://collab.test",
      creationFetch(requestUrl, undefined),
    );
    expect(sent[0]?.headers?.Authorization).toBeUndefined();
  });

  test("a refusal keeps its status: 401 is told apart", async () => {
    const { requestUrl } = request(401, {});
    await expect(
      createDocument(
        "https://collab.test",
        creationFetch(requestUrl, undefined),
      ),
    ).rejects.toThrow("(401)");
  });
});

describe("the keyring's requests through Obsidian (analysis 18m, M1)", () => {
  test("bytes both ways, the request's headers and the answer's", async () => {
    const sent: Parameters<Parameters<typeof requestFetch>[0]>[0][] = [];
    const fetch = requestFetch(async (param) => {
      sent.push(param);
      return {
        status: 200,
        headers: { etag: '"7"', "content-type": "application/octet-stream" },
        text: "",
        json: null,
        arrayBuffer: new Uint8Array([9, 8, 7]).buffer,
      } as never;
    });
    const response = await fetch("https://collab.test/keyrings/k", {
      method: "PUT",
      headers: { "If-Match": '"6"', "Keyring-Secret": "s" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"7"');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      9, 8, 7,
    ]);
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.headers).toEqual({
      "If-Match": '"6"',
      "Keyring-Secret": "s",
    });
    expect([...new Uint8Array(sent[0]?.body as ArrayBuffer)]).toEqual([
      1, 2, 3,
    ]);
    expect(sent[0]?.throw).toBe(false);
  });

  test("a body of a view sends only its bytes", async () => {
    const sent: unknown[] = [];
    const fetch = requestFetch(async (param) => {
      sent.push(param.body);
      return {
        status: 204,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      } as never;
    });
    const whole = new Uint8Array([0, 1, 2, 3, 4]);
    const response = await fetch("https://collab.test/x", {
      method: "PUT",
      body: whole.subarray(1, 3),
    });
    expect(response.status).toBe(204);
    expect([...new Uint8Array(sent[0] as ArrayBuffer)]).toEqual([1, 2]);
  });

  test("headers given as Headers are sent too", async () => {
    const sent: Record<string, string>[] = [];
    const fetch = requestFetch(async (param) => {
      sent.push(param.headers ?? {});
      return {
        status: 200,
        headers: {},
        text: "{}",
        json: {},
        arrayBuffer: new ArrayBuffer(0),
      } as never;
    });
    await fetch("https://collab.test/x", {
      headers: new Headers({ Authorization: "Bearer t" }),
    });
    expect(sent[0]).toEqual({ authorization: "Bearer t" });
  });
});

describe("testing the name and password of the settings", () => {
  /** A server behind nginx's `auth_basic` on `/documents` if `protected`,
   * accepting `alice:pässword`; the server itself answers 405 to a GET. */
  function server(isProtected: boolean) {
    const sent: { method?: string; url: string; body?: unknown }[] = [];
    const good = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode("alice:pässword")))}`;
    const requestUrl = async (param: RequestUrlParam) => {
      sent.push(param);
      const given = param.headers?.Authorization;
      const status = isProtected && given !== good ? 401 : 405;
      return {
        status,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      } as never;
    };
    return { sent, requestUrl };
  }
  const alice = { user: "alice", password: "pässword" };

  test("accepted, refused, or none asked; creating nothing", async () => {
    const guarded = server(true);
    expect(
      await checkCredentials("https://collab.test", guarded.requestUrl, alice),
    ).toBe("accepted");
    expect(
      await checkCredentials("https://collab.test", guarded.requestUrl, {
        user: "alice",
        password: "wrong",
      }),
    ).toBe("refused");
    expect(
      await checkCredentials(
        "https://collab.test",
        guarded.requestUrl,
        undefined,
      ),
    ).toBe("missing");
    const open = server(false);
    expect(
      await checkCredentials("https://collab.test", open.requestUrl, alice),
    ).toBe("not-asked");
    for (const { sent } of [guarded, open]) {
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) {
        expect(request.url).toBe("https://collab.test/documents");
        expect(request.method).toBe("GET");
        expect(request.body).toBeUndefined();
      }
    }
  });

  test("a server that cannot be reached is said so", async () => {
    expect(
      await checkCredentials(
        "https://collab.test",
        async () => {
          throw new Error("net::ERR_NAME_NOT_RESOLVED");
        },
        alice,
      ),
    ).toBe("unreachable");
  });
});
