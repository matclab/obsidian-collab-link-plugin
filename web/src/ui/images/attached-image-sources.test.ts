// The page's sources of a view's images (ADR-0057 §7, §8): the addresses
// they show an image through, never one of the page's origin for an SVG.
import { describe, expect, test } from "vitest";
import { imageAddress } from "./attached-image-sources.js";

const objects = () => {
  const made: Blob[] = [];
  return {
    made,
    urls: {
      create: (blob: Blob) => {
        made.push(blob);
        return `blob:page/${made.length}`;
      },
      revoke: () => {},
    },
  };
};

describe("an image's address", () => {
  test("an SVG through data:, never blob:, which has the page's origin", () => {
    const { made, urls } = objects();
    const bytes = new TextEncoder().encode("<svg><script>x</script></svg>");
    const url = imageAddress({ format: "svg", bytes }, urls);
    expect(url).toBe(
      `data:image/svg+xml;base64,${Buffer.from(bytes).toString("base64")}`,
    );
    expect(made).toEqual([]);
  });

  test("a raster image through blob:, typed from its bytes", () => {
    const { made, urls } = objects();
    for (const [format, type] of [
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["avif", "image/avif"],
    ] as const) {
      expect(imageAddress({ format, bytes: new Uint8Array(1) }, urls)).toMatch(
        /^blob:/,
      );
      expect(made.at(-1)?.type).toBe(type);
    }
  });
});
