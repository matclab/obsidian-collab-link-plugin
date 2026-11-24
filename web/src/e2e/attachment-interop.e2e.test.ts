// @vitest-environment node
//
// Phase 31d: attached images (docs/protocol/01-wire.md §1.12, K-19, D-40),
// the official client against the independent one (written from the
// specification alone): the same format for any bytes; what one seals,
// the other opens, and only under its identifiers; and both against the
// real server — the official client uploads, the independent one
// downloads, and the reverse.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createDocument,
  deriveRoleSecrets,
  downloadAttachment,
  generateKey,
  imageFormat,
  openImage,
  prepareImage,
  roleSecretHeader,
  uploadAttachment,
} from "../../lib/src/index.js";

// biome-ignore lint/suspicious/noExplicitAny: plain JavaScript, without types.
let independent: any;

const PORT = 18085;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const serverBinary = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../server/target/debug/server",
);
let server: ChildProcess;

beforeAll(async () => {
  // @ts-expect-error: plain JavaScript, without types.
  independent = await import("../../../independent-client/attachment.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "oc-images-e2e-"));
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
      await fetch(`${BASE_URL}/documents`, { method: "POST" });
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

const utf8 = (text: string) => new TextEncoder().encode(text);
const SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [...utf8("GIF89a")],
  [...utf8("RIFF\0\0\0\0WEBP")],
  [0, 0, 0, 0x1c, ...utf8("ftypavif")],
  [0xef, 0xbb, 0xbf],
];
const PROLOGUE = [
  " ",
  "\n",
  '<?xml version="1.0"?>',
  "<!-- a > b -->",
  "<!DOCTYPE svg>",
  "<!DOCTYPE svg [<!ENTITY x '>'>]>",
  "<!DOCTYPE svg [<!ENTITY x '>'>]>",
];
const SVG_PIECES = [
  "<!DOCTYPE [",
  "<svg",
  "<svgx",
  " ",
  "\n",
  ">",
  "/",
  '<?xml v="1"?>',
  "<!-- c -->",
  "<!--",
  "<!DOCTYPE svg [<!ENTITY x '>'>]>",
  "<html>",
  "]",
  "-->",
  "?>",
];

describe("attached images, official and independent", () => {
  test("D-40: the same format for any bytes", () =>
    hegel.test((tc) => {
      const kind = Math.min(
        2,
        tc.draw(gs.integers({ minValue: 0, maxValue: 3 })),
      );
      const bytes =
        kind === 0
          ? Uint8Array.from([
              ...tc.draw(gs.sampledFrom(SIGNATURES)),
              ...tc.draw(gs.binary({ maxSize: 16 })),
            ])
          : kind === 1
            ? utf8(
                tc
                  .draw(gs.arrays(gs.sampledFrom(SVG_PIECES), { maxSize: 6 }))
                  .join(""),
              )
            : // A prologue, then a first element: what D-40 reads.
              utf8(
                [
                  tc.draw(gs.sampledFrom(["", "\ufeff"])),
                  ...tc.draw(
                    gs.arrays(gs.sampledFrom(PROLOGUE), { maxSize: 4 }),
                  ),
                  // Weighted toward what D-40 accepts, where a divergence shows.
                  tc.draw(
                    gs.sampledFrom([
                      "<svg",
                      "<svg",
                      "<svg",
                      "<svgx",
                      "<html",
                      "<SVG",
                    ]),
                  ),
                  tc.draw(gs.sampledFrom([" ", "\t", ">", "/", "x", ""])),
                ].join(""),
              );
      const cut = bytes.subarray(
        0,
        tc.draw(gs.integers({ minValue: 0, maxValue: bytes.length })),
      );
      for (const b of [bytes, cut])
        expect(imageFormat(b)).toBe(independent.formatOf(b));
    }));

  test("K-19: what one seals, the other opens, under its identifiers only", () =>
    hegel.testAsync(async (tc) => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      const svg = utf8(`<svg>${tc.draw(gs.text({ maxSize: 12 }))}</svg>`);
      const prepared = await prepareImage(key, "doc", svg);
      if (typeof prepared === "string") throw new Error(prepared);
      expect(
        await independent.unsealImage(
          key,
          "doc",
          prepared.attachmentId,
          prepared.blob,
        ),
      ).toEqual(svg);
      expect(
        await independent.unsealImage(
          key,
          "dod",
          prepared.attachmentId,
          prepared.blob,
        ),
      ).toBeNull();

      const id = independent.newImageId();
      const blob = await independent.sealImage(key, "doc", id, svg);
      expect(await openImage(key, "doc", id, blob)).toEqual({
        format: "svg",
        bytes: svg,
      });
      const other = tc.draw(gs.sampledFrom(["doc2", ""]));
      expect(await openImage(key, other, id, blob)).toBe("unreadable");
    }));

  test("§1.12: through the real server, each downloads what the other uploaded", async () => {
    const created = await createDocument(BASE_URL);
    const secrets = await deriveRoleSecrets(created.editSecret);
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const prepared = await prepareImage(created.key, created.documentId, png);
    if (typeof prepared === "string") throw new Error(prepared);
    const editor = roleSecretHeader("edit", secrets.edit);
    expect(
      await uploadAttachment(
        BASE_URL,
        created.documentId,
        prepared.attachmentId,
        editor,
        prepared.blob,
      ),
    ).toBe("stored");
    const fetched = await independent.getImage(
      BASE_URL,
      created.documentId,
      prepared.attachmentId,
      "read",
      secrets.read,
    );
    expect(
      await independent.unsealImage(
        created.key,
        created.documentId,
        prepared.attachmentId,
        fetched,
      ),
    ).toEqual(png);

    const id = independent.newImageId();
    const sealed = await independent.sealImage(
      created.key,
      created.documentId,
      id,
      png,
    );
    expect(
      await independent.putImage(
        BASE_URL,
        created.documentId,
        id,
        "suggest",
        secrets.suggest,
        sealed,
      ),
    ).toBe(403);
    expect(
      await independent.putImage(
        BASE_URL,
        created.documentId,
        id,
        "edit",
        secrets.edit,
        sealed,
      ),
    ).toBe(201);
    const blob = await downloadAttachment(
      BASE_URL,
      created.documentId,
      id,
      roleSecretHeader("suggest", secrets.suggest),
    );
    if (blob === "absent") throw new Error("absent");
    expect(await openImage(created.key, created.documentId, id, blob)).toEqual({
      format: "png",
      bytes: png,
    });
    const unknown = await generateKey();
    expect(await openImage(unknown, created.documentId, id, blob)).toBe(
      "unreadable",
    );
  });
});
