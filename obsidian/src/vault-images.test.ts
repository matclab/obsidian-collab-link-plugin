import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import type { ImageFormat } from "../../web/lib/src/index.js";
import {
  foundFormat,
  imageFile,
  imageFolder,
  notedImages,
  toDocument,
  toNote,
} from "./vault-images.js";

const DOC = "Zm9vYmFyYmF6cXV4MTIzNA";
const OTHER = "b3RoZXJkb2N1bWVudDEyMw";
const A = "AAAAAAAAAAAAAAAAAAAAAA";
const B = "AQAAAAAAAAAAAAAAAAAAAg";
const formats: Record<string, ImageFormat> = { [A]: "png", [B]: "svg" };
const found = (id: string): ImageFormat | undefined => formats[id];

describe("an attached image's file in the vault (ADR-0058 §2)", () => {
  test("is under the plugin's folder, by document, named by its id and format", () => {
    expect(imageFolder("Collab Link", DOC)).toBe(`Collab Link/images/${DOC}`);
    expect(imageFile("Collab Link", DOC, A, "jpeg")).toBe(
      `Collab Link/images/${DOC}/${A}.jpg`,
    );
    expect(imageFile("/", DOC, A, "png")).toBe(`images/${DOC}/${A}.png`);
  });

  test("its format is found by the file there", () => {
    const there = new Set([`Collab Link/images/${DOC}/${A}.webp`]);
    const exists = (path: string) => there.has(path);
    expect(foundFormat(exists, "Collab Link", DOC, A)).toBe("webp");
    expect(foundFormat(exists, "Collab Link", DOC, B)).toBeUndefined();
    expect(foundFormat(exists, "Collab Link", OTHER, A)).toBeUndefined();
  });
});

describe("the note's text (ADR-0058 §1)", () => {
  test("cites a file found by its path from the vault's root, encoded", () => {
    expect(
      toNote(
        `![un (chien)](attachment:${A}) ![b](attachment:${B} "t")\n[r]: attachment:${A}`,
        DOC,
        "Collab Link/à (voir)",
        found,
      ),
    ).toBe(
      `![un (chien)](Collab%20Link/%C3%A0%20%28voir%29/images/${DOC}/${A}.png) ![b](Collab%20Link/%C3%A0%20%28voir%29/images/${DOC}/${B}.svg "t")\n[r]: Collab%20Link/%C3%A0%20%28voir%29/images/${DOC}/${A}.png`,
    );
  });

  test("leaves what has no file, or isn't an address of W-53", () => {
    const C = "AAAAAAAAAAAAAAAAAAAAAB"; // last character not of AQgw
    const text = `![c](attachment:CCCCCCCCCCCCCCCCCCCCCA) ![d](attachment:${C}) ![e](attachment:${A}x) xattachment:${A} \`attachment:${A}\``;
    expect(toNote(text, DOC, "Collab Link", found)).toBe(
      text.replace(
        `\`attachment:${A}\``,
        `\`Collab%20Link/images/${DOC}/${A}.png\``,
      ),
    );
  });
});

describe("back to the document's text (ADR-0058 §3)", () => {
  test("any folder before images/<this document>/ comes back as attachment:", () => {
    expect(
      toDocument(
        `![a](Old/images/${DOC}/${A}.png) ![b](images/${DOC}/${B}.svg) [r]: <x%20y/images/${DOC}/${A}.jpg>`,
        DOC,
      ),
    ).toBe(
      `![a](attachment:${A}) ![b](attachment:${B}) [r]: <attachment:${A}>`,
    );
  });

  test("another document's images, other extensions, other names stay", () => {
    const text = `![a](images/${OTHER}/${A}.png) ![b](images/${DOC}/${A}.pdf) ![c](images/${DOC}/${A}x.png) ![d](images/${DOC}/sub/${A}.png) ![e](ximages/${DOC}/${A}.png)`;
    expect(toDocument(text, DOC)).toBe(text);
  });

  test("the identifiers the text cites, once, in their order", () => {
    expect(
      notedImages(
        `![a](attachment:${B}) ![b](attachment:${A}) ![c](attachment:${B})`,
      ),
    ).toEqual([B, A]);
  });
});

const PIECES = [
  `attachment:${A}`,
  `attachment:${B}`,
  "attachment:",
  `images/${DOC}/${A}.png`,
  `Collab%20Link/images/${DOC}/${B}.svg`,
  `images/${OTHER}/${A}.png`,
  "![",
  "](",
  ")",
  "<",
  ">",
  " ",
  "\n",
  "x",
  "/",
  "[r]: ",
  "é",
];

const texts = gs
  .arrays(gs.sampledFrom(PIECES), { maxSize: 30 })
  .map((pieces) => pieces.join(""));
const folders = gs.sampledFrom(["Collab Link", "/", "a (b)/c", "Notes/é"]);
const lookups = gs.sampledFrom<(id: string) => ImageFormat | undefined>([
  found,
  () => undefined,
  (id) => (id === A ? "jpeg" : undefined),
]);

describe("the two rewrites, on any text", () => {
  test("the note, brought back, is the document brought back", () =>
    hegel.test((tc) => {
      const text = tc.draw(texts);
      const folder = tc.draw(folders);
      const lookup = tc.draw(lookups);
      expect(toDocument(toNote(text, DOC, folder, lookup), DOC)).toBe(
        toDocument(text, DOC),
      );
    }));

  test("without a file found, the note is the document; a text without paths comes back as it is", () =>
    hegel.test((tc) => {
      const text = tc.draw(texts);
      expect(toNote(text, DOC, tc.draw(folders), () => undefined)).toBe(text);
      if (!text.includes("images/")) expect(toDocument(text, DOC)).toBe(text);
    }));

  test("a text of the document, written to the note then brought back, is itself", () =>
    hegel.test((tc) => {
      const text = tc.draw(texts).replaceAll("images/", "pictures/");
      const note = toNote(text, DOC, tc.draw(folders), tc.draw(lookups));
      expect(toDocument(note, DOC)).toBe(text);
    }));
});
