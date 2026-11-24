/** A document's attached images in its export (ADR-0057 §8): the
 * identifiers its text cites, and the text with each image found
 * pointing to its file in the archive. Pure. */
import { type ImageFormat, isAttachmentId } from "../../lib/src/index.js";

export const EXTENSIONS: Record<ImageFormat, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  avif: "avif",
  svg: "svg",
};

const REFERENCE = /attachment:([A-Za-z0-9_-]{22})/g;

/** Each identifier the text cites, once, in its order. */
export function citedImages(markdown: string): string[] {
  const found = new Set<string>();
  for (const [, id] of markdown.matchAll(REFERENCE)) {
    if (id && isAttachmentId(id)) found.add(id);
  }
  return [...found];
}

/** The text, each image of `paths` cited by its path instead; the others
 * as they were. */
export function withImagePaths(
  markdown: string,
  paths: ReadonlyMap<string, string>,
): string {
  return markdown.replace(
    REFERENCE,
    (whole, id: string) => paths.get(id) ?? whole,
  );
}
