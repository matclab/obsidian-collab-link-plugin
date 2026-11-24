import { describe, expect, test } from "vitest";
import type { OpenedImage } from "../../web/lib/src/index.js";
import { ImageWriter } from "./image-writer.js";

const A = "AAAAAAAAAAAAAAAAAAAAAA";
const B = "AQAAAAAAAAAAAAAAAAAAAg";
const png: OpenedImage = { format: "png", bytes: Uint8Array.of(1) };

/** A writer whose images open when the test says. */
function setup(enabled = true) {
  const files = new Map<string, OpenedImage>();
  const asked: string[] = [];
  const opening = new Map<string, (image: OpenedImage | undefined) => void>();
  let written = 0;
  let on = enabled;
  const writer = new ImageWriter({
    enabled: () => on,
    found: (id) => files.get(id)?.format,
    image: (id) => {
      asked.push(id);
      return new Promise((resolve) => opening.set(id, resolve));
    },
    create: async (id, image) => {
      if (files.has(id)) throw new Error("name taken");
      files.set(id, image);
    },
    written: () => written++,
  });
  const open = async (id: string, image: OpenedImage | "none" = png) => {
    opening.get(id)?.(image === "none" ? undefined : image);
    opening.delete(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    writer,
    files,
    asked,
    open,
    written: () => written,
    setEnabled: (value: boolean) => {
      on = value;
    },
  };
}

describe("the writer of a view's images to the vault (ADR-0058 §2)", () => {
  test("one image at a time, each asked once, then the export told", async () => {
    const t = setup();
    t.writer.cited([A, B]);
    t.writer.cited([B, A]);
    expect(t.asked).toEqual([A]);
    await t.open(A);
    expect(t.files.get(A)).toBe(png);
    expect(t.written()).toBe(1);
    expect(t.asked).toEqual([A, B]);
    await t.open(B, "none");
    expect(t.files.has(B)).toBe(false);
    expect(t.written()).toBe(1);
    t.writer.cited([A, B]);
    expect(t.asked).toEqual([A, B]);
  });

  test("a file already in the vault is not asked for; one arrived meanwhile is not replaced", async () => {
    const t = setup();
    t.files.set(A, png);
    t.writer.cited([A, B]);
    expect(t.asked).toEqual([B]);
    const synced: OpenedImage = { format: "png", bytes: Uint8Array.of(2) };
    t.files.set(B, synced);
    await t.open(B);
    expect(t.files.get(B)).toBe(synced);
    expect(t.written()).toBe(0);
  });

  test("disabled, nothing is asked; disabled meanwhile, nothing is written", async () => {
    const t = setup(false);
    t.writer.cited([A]);
    expect(t.asked).toEqual([]);
    t.setEnabled(true);
    t.writer.cited([A]);
    expect(t.asked).toEqual([A]);
    t.setEnabled(false);
    await t.open(A);
    expect(t.files.size).toBe(0);
  });

  test("stopped, nothing more is written, even an image that opens after", async () => {
    const t = setup();
    t.writer.cited([A, B]);
    const stopped = t.writer.stop();
    await t.open(A);
    await stopped;
    expect(t.files.size).toBe(0);
    expect(t.asked).toEqual([A]);
    t.writer.cited([B]);
    expect(t.asked).toEqual([A]);
  });
});
