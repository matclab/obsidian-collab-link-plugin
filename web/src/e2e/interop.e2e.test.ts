// @vitest-environment node
//
// docs/phase-8-protocole-ouvert.md, 8d.2: the client an agent wrote from
// the specification alone (independent-client/, text-editor profile) and
// the official one, through the reference library (lib/), on the same
// document of a real server. Node, not jsdom: the independent client is a
// Node client (global WebSocket and events). Its own server, on its own
// port: the other e2e file runs alongside.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  LocalDecisions,
  createAnnotation,
  createDocument,
  documentLinks,
  listAnnotations,
  openLink,
  peerNames,
  resolveAnnotation,
  suggestAddition,
} from "../../lib/src/index.js";
import { eventually } from "../../lib/src/transport/test-support/eventually.js";
import { linkIndependentLoro } from "./independent-loro.js";

const PORT = 18083;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
let serverProcess: ChildProcess;

beforeAll(async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), "obsidian-collab-interop-"));
  serverProcess = spawn(path.join(root, "server/target/debug/server"), [], {
    env: {
      ...process.env,
      BIND_ADDR: `127.0.0.1:${PORT}`,
      DATABASE_PATH: path.join(dbDir, "journal.sqlite3"),
    },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${BASE_URL}/documents`, { method: "POST" });
      break; // listening: any answer will do
    } catch {
      if (attempt > 50) throw new Error("real server did not start in time");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  linkIndependentLoro();
});

afterAll(() => {
  serverProcess.kill();
});

test("the independent client runs the Loro version of the specification, the official one a later one", () => {
  const version = (dir: string) =>
    JSON.parse(
      readFileSync(
        path.join(root, dir, "node_modules/loro-crdt/package.json"),
        "utf8",
      ),
    ).version;
  expect(version("independent-client")).toBe("1.16.3");
  expect(version("web")).not.toBe("1.16.3");
});

test("an independent client and the official one write together, converge, and read each other's annotations", async () => {
  // @ts-expect-error: plain JavaScript, without types.
  const independent = await import("../../../independent-client/client.mjs");
  const created = await createDocument(BASE_URL);
  const links = await documentLinks(
    `${BASE_URL}/`,
    created.documentId,
    created.keyMaterial,
    created.editSecret,
  );
  const official = await openLink(links.edit);
  official.content.getText("content").insert(0, "shared text");
  official.content.commit();
  await official.whenPublished();
  const other = await independent.open(links.edit, {
    server: BASE_URL,
    pseudonym: "bob",
  });
  expect(other.content.getText("content").toString()).toBe("shared text");

  // Both write at once, at the two ends.
  official.content.getText("content").insert(0, "alpha ");
  official.content.commit();
  const otherText = other.content.getText("content");
  otherText.insert(otherText.length, " omega");
  other.content.commit();
  await Promise.all([official.whenPublished(), other.flushed()]);
  const converged = "alpha shared text omega";
  await eventually(
    () =>
      official.content.getText("content").toString() === converged &&
      other.content.getText("content").toString() === converged,
  );

  // The official client annotates; the independent one reads it.
  const comment = createAnnotation(official.content, official.annotations, {
    type: "comment",
    start: 6,
    end: 12,
    author: "alice",
    body: "which text?",
  });
  const suggestion = suggestAddition(official.content, official.annotations, {
    at: 17,
    text: " here",
    author: "alice",
  });
  await official.whenPublished();
  await eventually(() => other.list().length === 2);
  const read = Object.fromEntries(
    other.list().map((a: { id: string }) => [a.id, a]),
  );
  expect(read[comment]).toMatchObject({
    type: "comment",
    author: "alice",
    body: "which text?",
    range: { start: 6, end: 12 },
  });
  expect(read[suggestion]).toMatchObject({
    type: "addition",
    range: { start: 17, end: 17 },
  });

  // The independent one annotates, writing the entry as D-7 says; the
  // official one reads it, ignoring nothing. The map comes from the
  // independent client's own Loro module: an object of one WebAssembly
  // module handed to another corrupts its memory.
  const { LoroMap: IndependentLoroMap } = await import(
    "../../../independent-client/node_modules/loro-crdt/nodejs/index.js"
  );
  const entry = other.annotations
    .getMap("annotations")
    .setContainer("from-bob", new IndependentLoroMap());
  entry.set("type", "comment");
  entry.set("author", "bob");
  entry.set("status", "open");
  entry.set("createdAt", Date.now());
  entry.set("startCursor", otherText.getCursor(0, 0)?.encode());
  entry.set("endCursor", otherText.getCursor(4, 0)?.encode());
  entry.set("endOnLastChar", true);
  entry.set("body", "nice");
  other.annotations.commit();
  await other.flushed();
  await eventually(
    () => listAnnotations(official.content, official.annotations).length === 3,
  );
  expect(
    resolveAnnotation(official.content, official.annotations, "from-bob"),
  ).toMatchObject({
    type: "comment",
    author: "bob",
    body: "nice",
    range: { start: 0, end: 5 },
  });
  // The independent client registered who writes with its peers (D-19),
  // and the official one reads it.
  expect([...peerNames(official.annotations).values()]).toContain("bob");

  // The official client, an editor, resolves bob's comment: the
  // independent one derives it from the decisions journal.
  const decisions = new LocalDecisions(official.decisions, (record) =>
    official.connection.publishDecision(record),
  );
  decisions.propose("from-bob", "resolve", "alice");
  await eventually(
    () =>
      other.list().find((a: { id: string }) => a.id === "from-bob")?.decided ===
      "resolved",
  );

  official.close();
  other.close();
}, 30000);
