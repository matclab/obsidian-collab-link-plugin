import { describe, expect, test } from "vitest";
import {
  deriveRoleSecrets,
  exportKeyToBase64Url,
  parseLinkFragment,
  verifiers,
} from "../crypto/index.js";
import { createDocument, documentLinks } from "./links.js";

describe("createDocument (ADR-0019 §2)", () => {
  test("registers the verifiers of the three secrets derived from a fresh edit secret", async () => {
    const requests: { url: string; body: string }[] = [];
    const fetchStub = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ document_id: "doc-9" }));
    };

    const created = await createDocument("https://host", fetchStub);

    expect(created.documentId).toBe("doc-9");
    expect(requests.map((request) => request.url)).toEqual([
      "https://host/documents",
    ]);
    const expected = await verifiers(created.editSecret);
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      v: 1,
      verifiers: {
        read: b64(expected.read),
        suggest: b64(expected.suggest),
        edit: b64(expected.edit),
      },
    });
    expect(created.keyMaterial).toBe(await exportKeyToBase64Url(created.key));
  });

  test("fails on a refused request", async () => {
    const fetchStub = async () => new Response("", { status: 400 });

    await expect(createDocument("https://host", fetchStub)).rejects.toThrow();
  });

  // docs/phase-8-protocole-ouvert.md, N3.
  test("says to reload when the server speaks another protocol version", async () => {
    const fetchStub = async () => new Response("", { status: 426 });

    await expect(createDocument("https://host", fetchStub)).rejects.toThrow(
      /reload the page/,
    );
  });
});

describe("documentLinks", () => {
  test("gives each role its derived secret, the same key, the same document", async () => {
    const edit = new Uint8Array(32).fill(0x42);
    const secrets = await deriveRoleSecrets(edit);

    const links = await documentLinks(
      "https://host/app/?perf#old",
      "doc-9",
      "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      edit,
    );

    for (const role of ["read", "suggest", "edit"] as const) {
      const url = new URL(links[role]);
      expect(url.origin + url.pathname).toBe("https://host/app/");
      expect(url.searchParams.get("doc")).toBe("doc-9");
      expect(url.searchParams.has("perf")).toBe(false);
      expect(parseLinkFragment(url.hash)).toEqual({
        key: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
        role,
        secret: secrets[role],
      });
    }
  });
});
