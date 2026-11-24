import type { AnnotationsView } from "../../lib/src/index.js";
import {
  type ResolvedAnnotation,
  exportObstacles,
  writeCriticMarkup,
} from "./format.js";
import { opensEntry } from "./notes.js";

export type ExportResult =
  | {
      kind: "exported";
      markdown: string;
      /** Open annotations left out: no anchor any more, a proposed text
       * that doesn't decode (invalid, or not arrived yet), or inside a
       * substitution, whose old text holds no marker. */
      omitted: number;
      /** The text, a comment, a note, a reply or a proposed text holds a
       * marker or a note reference (CriticMarkup has no escape), a line
       * of a note's text opens an entry (`opensEntry`: it reads back as a
       * reply), or
       * an author can't be written in bold: read back, the file may
       * differ. */
      ambiguous: boolean;
      /** Comments written as a point (ADR-0034 §4): their range would
       * cross a suggestion or another comment; it won't come back. */
      pointed: number;
    }
  /** Crossing open annotations have no CriticMarkup form (ADR-0012):
   * nothing is written; the text alone can still be exported. */
  | { kind: "crossing"; pairs: number };

/** `text` and its open annotations as CriticMarkup (ADR-0003, phase 6
 * decision 8): what can be written is, the rest is counted. An addition's
 * or substitution's text is its change's, as decoded by the index
 * (ADR-0018). */
const MARKERS = [
  "{++",
  "++}",
  "{--",
  "--}",
  "{~~",
  "~>",
  "~~}",
  "{>>",
  "<<}",
  "{==",
  "==}",
];
const REFERENCE = /\[\^(?:cm|sg)-[0-9]+\]/;

function holdsMarker(value: string | undefined): boolean {
  return (
    value !== undefined &&
    (MARKERS.some((marker) => value.includes(marker)) || REFERENCE.test(value))
  );
}

/** A note's text read back otherwise: a marker, or a line after its
 * first that opens an entry of its own (ADR-0047 §6). */
function misreadInNote(value: string | undefined): boolean {
  return (
    holdsMarker(value) || (value ?? "").split("\n").slice(1).some(opensEntry)
  );
}

/** An author bold can't carry, or that reads back otherwise. */
const unwritable = (author: string) =>
  author.trim() === "" ||
  author !== author.trim() ||
  author.includes("*") ||
  author.includes("\n");

export function exportMarkdown(
  text: string,
  view: AnnotationsView,
): ExportResult {
  const open = view.annotations.filter((a) => a.status === "open");
  const resolved: ResolvedAnnotation[] = [];
  for (const annotation of open) {
    const { range } = annotation;
    if (!range) continue;
    if (annotation.type === "addition" || annotation.type === "substitution") {
      const preview = view.previews.get(annotation.id);
      if (preview?.kind !== "valid") continue;
      resolved.push({ ...annotation, range, proposed: preview.text });
    } else {
      resolved.push({ ...annotation, range });
    }
  }
  const { crossing, leftOut } = exportObstacles(text, resolved);
  if (crossing > 0) return { kind: "crossing", pairs: crossing };
  const written = resolved.filter((a) => !leftOut.includes(a.id));
  const { markdown, pointed } = writeCriticMarkup(text, written);
  return {
    kind: "exported",
    markdown,
    omitted: open.length - written.length,
    pointed,
    ambiguous:
      holdsMarker(text) ||
      written.some(
        (a) =>
          misreadInNote(a.body) ||
          misreadInNote(a.note) ||
          holdsMarker(a.proposed) ||
          unwritable(a.author) ||
          a.replies.some(
            (reply) => misreadInNote(reply.body) || unwritable(reply.author),
          ),
      ),
  };
}
