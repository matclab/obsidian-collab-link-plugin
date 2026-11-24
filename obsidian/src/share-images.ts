// A note's images at sharing (ADR-0057 §9): an `![[image]]` of the vault, which
// the others couldn't see, becomes an image attached to the new document, cited
// by `attachment:`; one not found, or not sent, stays as written, and is said.

const EMBED =
  /!\[\[([^\]|\n]+\.(?:png|jpe?g|gif|webp|avif|svg))(?:\|([^\]\n]*))?\]\]/gi;

export interface NoteImage {
  name: string;
  bytes: Uint8Array;
}

/** The text with each image found and sent cited by its identifier, and
 * the names of those that stay as written. */
export async function attachNoteImages(
  text: string,
  read: (linkpath: string) => Promise<NoteImage | undefined>,
  send: (image: NoteImage) => Promise<string | undefined>,
): Promise<{ text: string; kept: string[] }> {
  const sent = new Map<string, string | undefined>();
  for (const [, linkpath] of text.matchAll(EMBED)) {
    if (!linkpath || sent.has(linkpath)) continue;
    const image = await read(linkpath);
    sent.set(linkpath, image && (await send(image)));
  }
  const kept = [...sent].flatMap(([path, id]) => (id ? [] : [path]));
  return {
    text: text.replace(EMBED, (whole, linkpath: string, alias?: string) => {
      const id = sent.get(linkpath);
      if (!id) return whole;
      const alt = (
        alias ?? linkpath.replace(/^.*\//, "").replace(/\.[^.]+$/, "")
      )
        .replace(/[[\]\\]/g, " ")
        .trim();
      return `![${alt}](attachment:${id})`;
    }),
    kept,
  };
}
