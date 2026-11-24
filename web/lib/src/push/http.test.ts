// W-62, O-41: a post's outcome, from the route's answer; never an error.
import { describe, expect, test } from "vitest";
import { postNotification } from "./http.js";

const request = {
  endpoint: "https://fcm.googleapis.com/wp/a",
  ttl: 259_200,
  payload: Uint8Array.of(0xfb, 0xff, 0x00),
};

describe("posting a notification", () => {
  test("the body, the secret, the route", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const outcome = await postNotification(
      "https://collab.example",
      "0123456789abcdef0123456789abcdef",
      "suggest.c2VjcmV0",
      request,
      async (url, init) => {
        seen = { url, init };
        return new Response(null, { status: 202 });
      },
    );
    expect(outcome).toBe("sent");
    expect(seen?.url).toBe(
      "https://collab.example/documents/0123456789abcdef0123456789abcdef/push",
    );
    expect(seen?.init?.method).toBe("POST");
    expect(seen?.init?.headers).toEqual({
      "Role-Secret": "suggest.c2VjcmV0",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      endpoint: request.endpoint,
      ttl: 259_200,
      payload: "-_8A",
    });
  });

  test("each answer, and a network failure, as an outcome", async () => {
    const cases: [number, string][] = [
      [202, "sent"],
      [410, "gone"],
      [429, "limited"],
      [404, "refused"],
      [403, "refused"],
      [400, "refused"],
      [413, "refused"],
      [415, "refused"],
      [502, "failed"],
      [500, "failed"],
      [200, "failed"],
    ];
    for (const [status, outcome] of cases) {
      expect(
        await postNotification(
          "",
          "d",
          "s",
          request,
          async () => new Response(null, { status }),
        ),
        String(status),
      ).toBe(outcome);
    }
    expect(
      await postNotification("", "d", "s", request, async () => {
        throw new TypeError("offline");
      }),
    ).toBe("failed");
  });
});
