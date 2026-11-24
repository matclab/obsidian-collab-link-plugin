import {
  type CreatedDocument,
  type OpenedLink,
  deriveRoleSecrets,
  documentLinks,
  prepareImage,
  roleSecretHeader,
  uploadAttachment,
} from "../../web/lib/src/index.js";
import { importMarkdown } from "../../web/src/embed.js";
import { formatVersion, writeHeader } from "./note-header.js";
import { type NoteImage, attachNoteImages } from "./share-images.js";

/** Shares a note's `text` (docs/phase-14-plugin-obsidian.md, decisions 9 and
 * 11): a new document on `server`, the text imported into it — its YAML header
 * included, its CriticMarkup as annotations —, published and acknowledged; then
 * the link kept (SI2); then the file rewritten as the export of that version,
 * only if it is still `text` (SI1, SI3). Throws, keeping nothing and writing
 * nothing, if the document can't be created or the text published. */
export async function shareNote(options: {
  text: string;
  server: string;
  author: string;
  create: () => Promise<CreatedDocument>;
  connect: (url: string) => Promise<OpenedLink>;
  keep: (documentId: string, editLink: string) => void;
  rewrite: (fn: (current: string) => string) => Promise<string>;
  /** The note's links at sharing: the text the document gets; the file is still
   * compared with `text`. */
  links?: (text: string) => string;
  /** The note's `![[image]]` attached to the document (ADR-0057 §9): a
   * vault's file by its link, and the server's HTTP. */
  images?: {
    read: (linkpath: string) => Promise<NoteImage | undefined>;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
  };
}): Promise<
  | { ok: true; documentId: string; editLink: string; kept: string[] }
  | { ok: false; reason: "changed" }
> {
  const created = await options.create();
  const { documentId } = created;
  const links = await documentLinks(
    `${options.server}/`,
    documentId,
    created.keyMaterial,
    created.editSecret,
  );
  let shared = options.links ? options.links(options.text) : options.text;
  let kept: string[] = [];
  if (options.images) {
    const { read, fetch } = options.images;
    let secret: Promise<string> | undefined;
    const attached = await attachNoteImages(shared, read, async (image) => {
      secret ??= deriveRoleSecrets(created.editSecret).then(({ edit }) =>
        roleSecretHeader("edit", edit),
      );
      const prepared = await prepareImage(created.key, documentId, image.bytes);
      if (typeof prepared === "string") return undefined;
      const outcome = await uploadAttachment(
        options.server,
        documentId,
        prepared.attachmentId,
        await secret,
        prepared.blob,
        fetch,
      ).catch(() => "failed" as const);
      return outcome === "stored" ? prepared.attachmentId : undefined;
    });
    shared = attached.text;
    kept = attached.kept;
  }
  const opened = await options.connect(links.edit);
  let exported: string;
  try {
    importMarkdown(shared, opened.content, opened.annotations, options.author);
    await opened.whenPublished();
    exported = writeHeader(opened.content.getText("content").toString(), {
      document: documentId,
      version: formatVersion(opened.content.frontiers()),
    });
  } finally {
    opened.close();
  }
  options.keep(documentId, links.edit);
  let written = false;
  await options.rewrite((current) => {
    if (current !== options.text) return current;
    written = true;
    return exported;
  });
  return written
    ? { ok: true, documentId, editLink: links.edit, kept }
    : { ok: false, reason: "changed" };
}
