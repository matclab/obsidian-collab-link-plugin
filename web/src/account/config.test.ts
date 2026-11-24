// What the page is told of its deployment (`/config.json`, phase 18,
// decision 13; analyses 18i.2 and 18k): the gateway's origin, or none,
// and the attestation keys trusted — whatever the server answers, or if
// it doesn't.
import { describe, expect, test } from "vitest";
import { fetchPageConfig, readPageConfig } from "./config.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("the page's configuration", () => {
  test("names the gateway by its origin", async () => {
    const asked: string[] = [];
    const config = await readPageConfig("https://collab.test", async (url) => {
      asked.push(url);
      return json({ gateway: "https://accounts.example" });
    });
    expect(asked).toEqual(["https://collab.test/config.json"]);
    expect(config).toEqual({ gateway: "https://accounts.example" });
  });

  test("names the attestation keys trusted, with or without a gateway", async () => {
    const [a, b] = ["ab".repeat(32), "0f".repeat(32)];
    expect(
      await readPageConfig("https://collab.test", async () =>
        json({ gateway: "https://accounts.example", attestationKeys: [a, b] }),
      ),
    ).toEqual({ gateway: "https://accounts.example", attestationKeys: [a, b] });
    expect(
      await readPageConfig("https://collab.test", async () =>
        json({ attestationKeys: [a] }),
      ),
    ).toEqual({ attestationKeys: [a] });
  });

  // ADR-0057 §6: whether the server takes images, and their limits.
  test("says the server's limits of images, if it takes them", async () => {
    const read = (attachments: unknown) =>
      readPageConfig("https://collab.test", async () => json({ attachments }));
    expect(await read({ imageBytes: 10, documentBytes: 200 })).toEqual({
      attachments: { imageBytes: 10, documentBytes: 200 },
    });
    for (const wrong of [
      undefined,
      {},
      { imageBytes: 10 },
      { imageBytes: "10", documentBytes: 200 },
      { imageBytes: 0, documentBytes: 200 },
      { imageBytes: 1.5, documentBytes: 200 },
      { imageBytes: 2 ** 53, documentBytes: 200 },
      [10, 200],
    ]) {
      expect(await read(wrong), JSON.stringify(wrong)).toEqual({});
    }
  });

  // ADR-0060, W-65: the server's VAPID key, if it posts notifications.
  test("gives the server's VAPID key, a 65-byte point, if it posts notifications", async () => {
    const read = (push: unknown) =>
      readPageConfig("https://collab.test", async () => json({ push }));
    const key = Uint8Array.of(4, ...new Uint8Array(64).fill(0xfb));
    const encoded = Buffer.from(key).toString("base64url");
    expect(await read({ vapidKey: encoded })).toEqual({
      push: { vapidKey: key },
    });
    for (const wrong of [
      undefined,
      {},
      { vapidKey: Buffer.from(key.slice(1)).toString("base64url") },
      {
        vapidKey: Buffer.from(Uint8Array.of(2, ...key.slice(1))).toString(
          "base64url",
        ),
      },
      { vapidKey: `${encoded}=` },
      { vapidKey: Buffer.from(key).toString("base64") },
      { vapidKey: 4 },
      [encoded],
    ]) {
      expect(await read(wrong), JSON.stringify(wrong)).toEqual({});
    }
  });

  test("a key not a fingerprint is no key; the rest stands", async () => {
    const a = "ab".repeat(32);
    for (const keys of [
      ["AB".repeat(32)],
      ["ab".repeat(31)],
      [7],
      "not a list",
      [`${a} `],
    ]) {
      expect(
        await readPageConfig("https://collab.test", async () =>
          json({ gateway: "https://accounts.example", attestationKeys: keys }),
        ),
        JSON.stringify(keys),
      ).toEqual({ gateway: "https://accounts.example" });
    }
    expect(
      await readPageConfig("https://collab.test", async () =>
        json({ attestationKeys: [a, "x"] }),
      ),
    ).toEqual({ attestationKeys: [a] });
  });

  // Analysis 18o.2: « Identité <name> ».
  test("names the organisation, if it is text to show", async () => {
    const read = (orgName: unknown) =>
      readPageConfig("https://collab.test", async () => json({ orgName }));
    expect(await read("Systerel R&D")).toEqual({ orgName: "Systerel R&D" });
    expect(await read("é".repeat(64))).toEqual({ orgName: "é".repeat(64) });
    for (const refused of [
      "",
      " Systerel",
      "é".repeat(65),
      "Sys\ntérel",
      "Sys\u202etérel",
      "Sys\u200btérel",
      7,
      ["Systerel"],
    ]) {
      expect(await read(refused), JSON.stringify(refused)).toEqual({});
    }
  });

  test("anything else is no gateway", async () => {
    for (const answer of [
      () => json({}),
      () => json({ gateway: "https://accounts.example/path" }),
      () => json({ gateway: "javascript:alert(1)" }),
      () => json({ gateway: "accounts.example" }),
      () => json({ gateway: 7 }),
      () => json([]),
      () => json({ gateway: "https://accounts.example" }, 404),
      () => new Response("not json"),
      () => {
        throw new TypeError("offline");
      },
    ]) {
      expect(
        await readPageConfig("https://collab.test", async () => answer()),
      ).toEqual({});
    }
  });

  // « Lire depuis le serveur » tells a server it can't read from one that
  // names nothing.
  test("fetched: no configuration at all if the server's answer isn't one", async () => {
    for (const answer of [
      () => json({ gateway: "https://accounts.example" }, 404),
      () => new Response("not json"),
      () => json([]),
      () => {
        throw new TypeError("offline");
      },
    ]) {
      expect(
        await fetchPageConfig("https://collab.test", async () => answer()),
      ).toBeUndefined();
    }
    expect(
      await fetchPageConfig("https://collab.test", async () => json({})),
    ).toEqual({});
    expect(
      await fetchPageConfig("https://collab.test", async () =>
        json({ gateway: "https://accounts.example" }),
      ),
    ).toEqual({ gateway: "https://accounts.example" });
  });
});
