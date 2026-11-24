import type { LoroDoc } from "loro-crdt";
import {
  createAnnotation,
  replyToAnnotation,
  suggestAddition,
  tryCreateAnnotation,
} from "../../lib/src/index.js";
import { asNoteText } from "./notes.js";
import {
  type ImportNotice,
  type ParsedAnnotation,
  parseCriticMarkup,
} from "./parse.js";

/** An empty side keeps its meaning: a substitution of nothing is an
 * addition, by nothing a deletion; an addition or a deletion of nothing
 * changes nothing, an empty comment — or one of blanks only — says
 * nothing: dropped. */
function normalize(
  parsed: ParsedAnnotation,
  notices: ImportNotice[],
): ParsedAnnotation | undefined {
  const proposed = parsed.proposed ?? "";
  if (parsed.type === "addition" && proposed === "") {
    notices.push({ kind: "dropped", type: "addition", at: parsed.start });
    return undefined;
  }
  if (parsed.type === "substitution" && proposed === "") {
    const { proposed: _, ...rest } = parsed;
    return normalize({ ...rest, type: "deletion" }, notices);
  }
  if (parsed.type === "comment" && !parsed.body?.trim() && !parsed.replies) {
    notices.push({ kind: "dropped", type: "comment", at: parsed.start });
    return undefined;
  }
  if (parsed.type === "deletion" && parsed.start === parsed.end) {
    notices.push({ kind: "dropped", type: "deletion", at: parsed.start });
    return undefined;
  }
  if (parsed.type === "substitution" && parsed.start === parsed.end) {
    return { ...parsed, type: "addition" };
  }
  return {
    ...parsed,
    ...(parsed.body !== undefined && { body: asNoteText(parsed.body) }),
    ...(parsed.note !== undefined && { note: asNoteText(parsed.note) }),
  };
}

/** A CriticMarkup `.md` into an empty document (phase 6 decision 8): the
 * clean text into `content`, each annotation with its note's author, date
 * and replies (ADR-0034, ADR-0035 §6) — `author`'s, dated now, without
 * one (plain CriticMarkup carries no author) —, an addition's or
 * substitution's text as a detached change (ADR-0018). Returns what the
 * import had to move, drop, or found changed. */
export function importMarkdown(
  markdown: string,
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  author: string,
): ImportNotice[] {
  const parsedMarkup = parseCriticMarkup(markdown);
  const { text } = parsedMarkup;
  const notices = [...parsedMarkup.notices];
  const annotations = parsedMarkup.annotations.flatMap(
    (parsed) => normalize(parsed, notices) ?? [],
  );
  contentDoc.getText("content").insert(0, text);
  contentDoc.commit();
  for (const parsed of annotations) {
    const common = {
      author: parsed.author ?? author,
      ...(parsed.note !== undefined && { note: parsed.note }),
      ...(parsed.createdAt !== undefined && { createdAt: parsed.createdAt }),
    };
    let id: string | undefined;
    switch (parsed.type) {
      case "addition":
        id = suggestAddition(contentDoc, annotationsDoc, {
          at: parsed.start,
          text: parsed.proposed ?? "",
          ...common,
        });
        break;
      case "substitution": {
        const created = tryCreateAnnotation(contentDoc, annotationsDoc, {
          type: "substitution",
          start: parsed.start,
          end: parsed.end,
          replacement: parsed.proposed ?? "",
          ...common,
        });
        id = created.ok ? created.id : undefined;
        break;
      }
      default:
        id = createAnnotation(contentDoc, annotationsDoc, {
          type: parsed.type,
          start: parsed.start,
          end: parsed.end,
          ...(parsed.body !== undefined && { body: parsed.body }),
          ...common,
        });
    }
    if (id === undefined) continue;
    for (const reply of parsed.replies ?? []) {
      replyToAnnotation(annotationsDoc, id, {
        author: reply.author ?? author,
        body: reply.body,
        ...(reply.createdAt !== undefined && { createdAt: reply.createdAt }),
      });
    }
  }
  return notices;
}
