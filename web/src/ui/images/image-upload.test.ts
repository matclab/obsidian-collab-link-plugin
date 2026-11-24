// @vitest-environment jsdom
//
// What a failed upload says (ADR-0057 §8): the server unreachable only
// when it is, its answer otherwise — a proxy's included.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "vitest";
import { type PreparedImage, generateKey } from "../../../lib/src/index.js";
import { holdPosition, imageInsertion } from "../../editor/image-insertion.js";
import { t } from "../../i18n/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import { createImageUploader } from "./image-upload.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function noticeOf(answer: () => Promise<Response>): Promise<string[]> {
  const view = new EditorView({
    state: EditorState.create({ extensions: [imageInsertion()] }),
    parent: document.createElement("div"),
  });
  const notices: string[] = [];
  const key = await generateKey();
  const uploader = createImageUploader({
    apiBase: "https://s",
    documentId: "doc",
    key,
    roleSecret: () => "edit.x",
    fetch: answer,
    imageBytes: 1000,
    attached: { add: () => {} } as unknown as AttachedImages,
    notify: (message) => notices.push(message),
    status: document.createElement("div"),
    chooseFiles: async () => [],
    prepare: async (_key, _doc, bytes) =>
      ({
        attachmentId: "AAAAAAAAAAAAAAAAAAAAAA",
        format: "png",
        bytes,
        blob: bytes,
      }) satisfies PreparedImage,
  });
  const file = {
    name: "qrcode.png",
    size: PNG.length,
    arrayBuffer: async () => PNG.slice().buffer,
  } as unknown as File;
  uploader.insert(view, [file], holdPosition(view, 0));
  for (let i = 0; i < 10 && notices.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  view.destroy();
  return notices;
}

describe("a failed upload", () => {
  test("unreachable, only when the request found no server", async () => {
    expect(
      await noticeOf(() => Promise.reject(new TypeError("offline"))),
    ).toEqual([t().imageUploadFailed("qrcode.png")]);
  });

  test("an answer the specification doesn't give is named", async () => {
    for (const status of [401, 500, 502]) {
      expect(
        await noticeOf(async () => new Response(null, { status })),
      ).toEqual([t().imageUploadAnswered("qrcode.png", status)]);
    }
  });

  test("a 413 for a file under the server's limit: a lower limit, maybe a proxy's", async () => {
    expect(
      await noticeOf(async () => new Response(null, { status: 413 })),
    ).toEqual([t().imageRefusedTooLarge("qrcode.png")]);
  });

  test("an identifier taken is the server's answer, not a lost server", async () => {
    expect(
      await noticeOf(async () => new Response(null, { status: 409 })),
    ).toEqual([t().imageUploadAnswered("qrcode.png", 409)]);
  });
});
