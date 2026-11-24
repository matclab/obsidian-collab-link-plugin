// An image's upload and download (docs/protocol/01-wire.md §1.12): the
// request each makes, and what each answer means.
import { describe, expect, test } from "vitest";
import {
  UnexpectedAnswer,
  downloadAttachment,
  roleSecretHeader,
  uploadAttachment,
} from "./http.js";

function server(status: number, body: Uint8Array = new Uint8Array(0)) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(status === 204 ? null : (body as BodyInit), { status });
  };
  return { requests, fetchFn };
}

const ID = "AAECAwQFBgcICQoLDA0ODw";

describe("an image over HTTP", () => {
  test("W-54: the secret goes in Role-Secret, as a link writes it", () => {
    expect(roleSecretHeader("edit", new Uint8Array(32).fill(0xff))).toBe(
      `edit.${"_".repeat(42)}8`,
    );
  });

  test("an upload puts the blob, typed, under the role's secret", async () => {
    const { requests, fetchFn } = server(201);
    const blob = Uint8Array.from([1, 2, 3]);
    expect(
      await uploadAttachment("https://s", "doc", ID, "edit.x", blob, fetchFn),
    ).toBe("stored");
    expect(requests[0]?.url).toBe(`https://s/documents/doc/attachments/${ID}`);
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(requests[0]?.init?.headers).toEqual({
      "Role-Secret": "edit.x",
      "Content-Type": "application/octet-stream",
    });
    expect(requests[0]?.init?.body).toBe(blob);
  });

  test.each([
    [404, "missing"],
    [403, "forbidden"],
    [413, "too-large"],
    [507, "full"],
    [409, "taken"],
  ])("W-55: an upload answered %i is %s", async (status, outcome) => {
    const { fetchFn } = server(status);
    expect(
      await uploadAttachment("", "d", ID, "edit.x", new Uint8Array(0), fetchFn),
    ).toBe(outcome);
  });

  test("an answer the specification doesn't give is an error that says it", async () => {
    for (const status of [200, 400, 500]) {
      const { fetchFn } = server(status);
      await expect(
        uploadAttachment("", "d", ID, "edit.x", new Uint8Array(0), fetchFn),
      ).rejects.toEqual(new UnexpectedAnswer(status));
    }
    for (const status of [201, 403, 500]) {
      const { fetchFn } = server(status);
      await expect(
        downloadAttachment("", "d", ID, "read.x", fetchFn),
      ).rejects.toEqual(new UnexpectedAnswer(status));
    }
  });

  test("W-57: a download gives the blob, or `absent`", async () => {
    const found = server(200, Uint8Array.from([9, 8]));
    expect(
      await downloadAttachment("", "d", ID, "read.x", found.fetchFn),
    ).toEqual(Uint8Array.from([9, 8]));
    expect(found.requests[0]?.init?.headers).toEqual({
      "Role-Secret": "read.x",
    });
    expect(
      await downloadAttachment("", "d", ID, "read.x", server(404).fetchFn),
    ).toBe("absent");
  });
});
