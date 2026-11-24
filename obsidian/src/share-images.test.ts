import { describe, expect, test } from "vitest";
import { attachNoteImages } from "./share-images.js";

describe("a note's images at sharing", () => {
  test("each image found and sent is attached; the others stay as written", async () => {
    const asked: string[] = [];
    const out = await attachNoteImages(
      "![[a.png]] ![[dir/b.JPG|un chien]] ![[a.png]] ![[gone.png]] ![[fails.svg]] ![[note]] ![[doc.pdf]]",
      async (path) => {
        asked.push(path);
        return path === "gone.png"
          ? undefined
          : { name: path, bytes: Uint8Array.of(1) };
      },
      async (image) =>
        image.name === "fails.svg" ? undefined : `ID-${image.name}`,
    );
    expect(asked).toEqual(["a.png", "dir/b.JPG", "gone.png", "fails.svg"]);
    expect(out.text).toBe(
      "![a](attachment:ID-a.png) ![un chien](attachment:ID-dir/b.JPG) ![a](attachment:ID-a.png) ![[gone.png]] ![[fails.svg]] ![[note]] ![[doc.pdf]]",
    );
    expect(out.kept).toEqual(["gone.png", "fails.svg"]);
  });
});
