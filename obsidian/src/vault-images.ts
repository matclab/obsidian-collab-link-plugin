// A linked note's attached images, as files of the vault (ADR-0058): the
// document cites `attachment:<id>`; its note, once a file is written,
// that file's path from the vault's root. Both rewrites are of the text
// alone, and pure: brought back, a note is compared to its document
// whatever device, version or folder wrote it (§3).
import { type ImageFormat, isAttachmentId } from "../../web/lib/src/index.js";

const EXTENSIONS: Record<ImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  avif: "avif",
  svg: "svg",
};

/** What a path, encoded, is made of: an address cited is one only between
 * other characters, in both directions, so that a rewrite never joins a
 * neighbour. */
const PATH = "A-Za-z0-9_.~%/-";
const ID = "[A-Za-z0-9_-]{22}";
const REFERENCE = new RegExp(
  `(?<![${PATH}:])attachment:(${ID})(?![${PATH}])`,
  "g",
);

/** The folder of a document's images, from the vault's root. */
export function imageFolder(folder: string, documentId: string): string {
  const root = folder.replace(/^\/+|\/+$/g, "");
  return root === "" ? `images/${documentId}` : `${root}/images/${documentId}`;
}

/** An image's file, from the vault's root. */
export function imageFile(
  folder: string,
  documentId: string,
  id: string,
  format: ImageFormat,
): string {
  return `${imageFolder(folder, documentId)}/${id}.${EXTENSIONS[format]}`;
}

/** The format of the image's file in the vault, if `exists` finds one. */
export function foundFormat(
  exists: (path: string) => boolean,
  folder: string,
  documentId: string,
  id: string,
): ImageFormat | undefined {
  return (Object.keys(EXTENSIONS) as ImageFormat[]).find((format) =>
    exists(imageFile(folder, documentId, id, format)),
  );
}

/** A path as an address: each segment encoded, parentheses too (they end
 * a Markdown destination). */
function address(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** Each identifier the text cites, once, in its order. */
export function notedImages(text: string): string[] {
  const ids = new Set<string>();
  for (const [, id] of text.matchAll(REFERENCE)) {
    if (id && isAttachmentId(id)) ids.add(id);
  }
  return [...ids];
}

/** The note's text: each image whose file `found` gives cited by its
 * path; the rest as it is. */
export function toNote(
  text: string,
  documentId: string,
  folder: string,
  found: (id: string) => ImageFormat | undefined,
): string {
  return text.replace(REFERENCE, (whole, id: string) => {
    const format = isAttachmentId(id) ? found(id) : undefined;
    return format ? address(imageFile(folder, documentId, id, format)) : whole;
  });
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The document's text: each path of an image of `documentId`, whatever
 * folder precedes `images/`, cited as `attachment:` again. */
export function toDocument(text: string, documentId: string): string {
  const extensions = Object.values(EXTENSIONS).join("|");
  const path = new RegExp(
    `(?<![${PATH}:])(?:[${PATH}]*/)?images/${literal(address(documentId))}/(${ID})\\.(?:${extensions})(?![${PATH}])`,
    "g",
  );
  return text.replace(path, (whole, id: string) =>
    isAttachmentId(id) ? `attachment:${id}` : whole,
  );
}
