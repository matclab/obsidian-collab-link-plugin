// @vitest-environment node
//
// Phase 18c: the keyring against the real server (server/target/debug/
// server, docs/protocol/05-keyring.md). Two devices sync one keyring at
// once, through every request the library sends: both end with every
// document (TR1). What reaches the server, headers and bodies, holds
// neither K_t nor any document link (TR3, KR-17; checked again on the
// pages' requests in 18l). After the keyring is deleted, a sync says so
// and the copy stays (cas 12).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bytesToBase64Url } from "../../lib/src/crypto/role-secrets.js";
import {
  createKeyring,
  httpKeyringTransport,
  listKeyring,
  newKeyringDoc,
  rememberLink,
  syncKeyring,
} from "../../lib/src/index.js";

const PORT = 18084;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const serverBinary = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../server/target/debug/server",
);

let server: ChildProcess;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-keyring-e2e-"));
  server = spawn(serverBinary, [], {
    env: {
      ...process.env,
      BIND_ADDR: `127.0.0.1:${PORT}`,
      DATABASE_PATH: path.join(dir, "db.sqlite3"),
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${BASE_URL}/keyrings`, { method: "POST" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("real server did not start in time");
});

afterAll(() => {
  server?.kill();
});

/** Every request, as the server receives it. */
const seen: string[] = [];
const recordingFetch = async (url: string, init: RequestInit = {}) => {
  const headers: string[] = [];
  new Headers(init.headers).forEach((value, name) =>
    headers.push(`${name}: ${value}`),
  );
  const body =
    init.body instanceof Uint8Array
      ? Buffer.from(init.body).toString("latin1")
      : String(init.body ?? "");
  seen.push(`${url} ${headers.join(" ")} ${body}`);
  return fetch(url, init);
};

const KEY = bytesToBase64Url(new Uint8Array(32).fill(0xa0));
const link = (device: number, n: number) =>
  `https://collab.example.org/?doc=d${device}x${n}#k=${KEY}&r=edit.${bytesToBase64Url(new Uint8Array(32).fill(device * 16 + n))}`;

describe("the keyring on the real server", () => {
  test("TR1, TR3: two devices syncing at once lose nothing, and send nothing in clear", async () => {
    const created = await createKeyring(BASE_URL, recordingFetch);
    const devices = [newKeyringDoc(), newKeyringDoc()];
    const transport = httpKeyringTransport(BASE_URL, created, recordingFetch);
    const all: string[] = [];
    for (let round = 0; round < 5; round++) {
      devices.forEach((doc, d) => {
        rememberLink(doc, link(d, round), { at: round });
        all.push(`d${d}x${round}`);
      });
      const outcomes = await Promise.all(
        devices.map((doc) =>
          syncKeyring(doc, created.key, transport, {
            attempts: 20,
            wait: async () => {},
          }),
        ),
      );
      for (const outcome of outcomes) expect(outcome.kind).toBe("synced");
    }
    // A last round: each sees what the other wrote last.
    for (const doc of devices) await syncKeyring(doc, created.key, transport);
    for (const doc of devices) {
      expect(
        listKeyring(doc)
          .map((e) => e.documentId)
          .sort(),
      ).toEqual(all.sort());
    }
    const everything = seen.join("\n");
    expect(everything).not.toContain(bytesToBase64Url(created.key));
    expect(everything).not.toContain(created.link);
    expect(everything).not.toContain("collab.example.org");
    expect(everything).not.toContain(KEY);
  });

  test("cas 12: a deleted keyring is missing, and the copy stays", async () => {
    const created = await createKeyring(BASE_URL);
    const doc = newKeyringDoc();
    rememberLink(doc, link(0, 0), { at: 0 });
    const transport = httpKeyringTransport(BASE_URL, created);
    expect((await syncKeyring(doc, created.key, transport)).kind).toBe(
      "synced",
    );
    const response = await fetch(`${BASE_URL}/keyrings/${created.keyringId}`, {
      method: "DELETE",
      headers: { "Keyring-Secret": bytesToBase64Url(created.secret) },
    });
    expect(response.status).toBe(204);
    expect((await syncKeyring(doc, created.key, transport)).kind).toBe(
      "missing",
    );
    expect(listKeyring(doc)).toHaveLength(1);
  });
});
