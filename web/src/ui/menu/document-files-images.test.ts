// @vitest-environment jsdom
// The export of a document citing attached images (ADR-0057 §8): a .zip
// of its text, each image found cited by its file in it, and the images;
// one not found stays cited, and the message says so. Without one, the
// .md as before.
import { LoroDoc } from "loro-crdt";
import { describe, expect, test } from "vitest";
import { AnnotationIndex } from "../../../lib/src/annotations/index.js";
import { createDocumentEditor } from "../../editor/editor.js";
import { t } from "../../i18n/index.js";
import type { AttachedImages } from "../../view-model/attached-images.js";
import { createDocumentFiles } from "./document-files.js";

const A = "AAECAwQFBgcICQoLDA0ODw";
const B = "AQECAwQFBgcICQoLDA0ODw";

function exportOf(text: string) {
  const contentDoc = new LoroDoc();
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  const editor = createDocumentEditor(
    document.createElement("div"),
    contentDoc,
  );
  const index = new AnnotationIndex(contentDoc, new LoroDoc());
  const container = document.createElement("div");
  const saved: { name: string; content: string | Uint8Array }[] = [];
  const images = {
    opened: async (id: string) =>
      id === A
        ? { format: "png" as const, bytes: Uint8Array.of(1, 2, 3) }
        : undefined,
  } as unknown as AttachedImages;
  createDocumentFiles(container, {
    editor,
    index,
    role: "read",
    author: () => "carol",
    save: (name, content) => saved.push({ name, content }),
    images,
  });
  Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "Export the text only")
    ?.click();
  return { saved, container };
}

/** The names and contents of a stored zip (the writer's own test reads it
 * against the format). */
function entries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const out = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(
      archive.subarray(at + 30, at + 30 + nameLength),
    );
    const data = archive.subarray(
      at + 30 + nameLength,
      at + 30 + nameLength + size,
    );
    out.set(
      name,
      name.endsWith(".md")
        ? new TextDecoder().decode(data)
        : Array.from(data).join(","),
    );
    at += 30 + nameLength + size;
  }
  return out;
}

describe("an export with attached images", () => {
  test("a zip of the text and its images; one not found stays cited", async () => {
    const { saved, container } = exportOf(
      `# Plan\n\n![a](attachment:${A}) ![b](attachment:${B})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved.map((file) => file.name)).toEqual(["Plan.zip"]);
    const files = entries(saved[0]?.content as Uint8Array);
    expect([...files.keys()]).toEqual(["Plan.md", `images/${A}.png`]);
    expect(files.get("Plan.md")).toBe(
      `# Plan\n\n![a](images/${A}.png) ![b](attachment:${B})`,
    );
    expect(files.get(`images/${A}.png`)).toBe("1,2,3");
    expect(container.querySelector(".files-message")?.textContent).toBe(
      t().exportImagesMissing(1),
    );
  });

  test("without an image, the .md as before", () => {
    const { saved } = exportOf("# Plan\n\ntext");
    expect(saved).toEqual([{ name: "Plan.md", content: "# Plan\n\ntext" }]);
  });
});
