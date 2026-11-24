import { describe, expect, test } from "vitest";
import { citedImages, withImagePaths } from "./export-images.js";

const A = "AAECAwQFBgcICQoLDA0ODw";
const B = "AQECAwQFBgcICQoLDA0ODw";

describe("the images of an export", () => {
  test("each identifier cited, once, in order; not one of another form", () => {
    expect(
      citedImages(
        `![a](attachment:${B}) ![b](attachment:${A})\n[r]: attachment:${B}\nattachment:AAECAwQFBgcICQoLDA0ODB`,
      ),
    ).toEqual([B, A]);
  });

  test("an image found points to its file; one not found stays cited", () => {
    expect(
      withImagePaths(
        `![a](attachment:${A}) ![b](attachment:${B})`,
        new Map([[A, "images/a.png"]]),
      ),
    ).toBe(`![a](images/a.png) ![b](attachment:${B})`);
  });
});
