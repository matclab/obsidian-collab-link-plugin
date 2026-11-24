// A file to a blob and back (ADR-0057 §1, D-40, K-19): an image comes back
// as it was uploaded, its metadata aside; whatever the server sends — any
// bytes, another image's blob — opens as `unreadable`, never an exception.
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { generateKey } from "../crypto/aead.js";
import { isAttachmentId } from "./crypto.js";
import { openImage, prepareImage } from "./image.js";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

describe("an image prepared and opened", () => {
  test("round trip: what is opened is what was prepared, under its identifiers only", () =>
    hegel.testAsync(async (tc) => {
      const key = await generateKey();
      const svg = tc.draw(gs.booleans());
      const body = tc.draw(gs.binary({ maxSize: 64 }));
      const file = svg
        ? new TextEncoder().encode(
            `<svg>${tc.draw(gs.text({ maxSize: 20 }))}</svg>`,
          )
        : Uint8Array.from([
            ...PNG,
            0,
            0,
            0,
            body.length,
            0x49,
            0x44,
            0x41,
            0x54,
            ...body,
            0,
            0,
            0,
            0,
            ...iend,
          ]);
      const prepared = await prepareImage(key, "doc", file);
      if (typeof prepared === "string") throw new Error(prepared);
      expect(isAttachmentId(prepared.attachmentId)).toBe(true);
      expect(prepared.bytes).toEqual(file);

      const opened = await openImage(
        key,
        "doc",
        prepared.attachmentId,
        prepared.blob,
      );
      expect(opened).toEqual({ format: svg ? "svg" : "png", bytes: file });
      expect(
        await openImage(key, "other", prepared.attachmentId, prepared.blob),
      ).toBe("unreadable");
      expect(
        await openImage(key, "doc", "AQECAwQFBgcICQoLDA0ODw", prepared.blob),
      ).toBe("unreadable");
    }));

  test("any bytes from the server open as unreadable, never an exception", () =>
    hegel.testAsync(async (tc) => {
      const key = await generateKey();
      const blob = tc.draw(gs.binary({ maxSize: 128 }));
      const id = tc.draw(gs.text({ maxSize: 24 }));
      expect(
        await openImage(key, tc.draw(gs.text({ maxSize: 8 })), id, blob),
      ).toBe("unreadable");
    }));

  test("a file of no format of D-40 is not prepared", async () => {
    const key = await generateKey();
    expect(
      await prepareImage(key, "d", new TextEncoder().encode("%PDF-1.7")),
    ).toBe("not-an-image");
    expect(await prepareImage(key, "d", Uint8Array.from(PNG))).toBe(
      "malformed",
    );
  });
});
