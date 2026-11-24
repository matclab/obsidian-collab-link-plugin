import type { LoroDoc } from "loro-crdt";
import { annotationAnchor } from "../../../lib/src/index.js";
import {
  type AnnotatedText,
  annotatedTextAt,
  authors,
} from "../../history/index.js";
import { formatShortDate, t } from "../../i18n/index.js";
import type { ThenText } from "./card-model.js";

/** The text annotation `id` covers or covered, as a card and the journal
 * show it (ADR-0052 §4): who deleted it, by the name the history gives
 * that peer, and when. Never on a rendering: a click, an export. */
export function thenText(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  id: string,
): ThenText {
  return thenTextAt(contentDoc, annotationsDoc, id).text;
}

/** The same, and where its range stands in today's text. */
export function thenTextAt(
  contentDoc: LoroDoc,
  annotationsDoc: LoroDoc,
  id: string,
): { text: ThenText; at: { start: number; end: number } | undefined } {
  const anchor = annotationAnchor(annotationsDoc, id);
  if (!anchor) return { text: undefined, at: undefined };
  const { text, at } = annotatedTextAt(contentDoc, anchor);
  return { text: shown(annotationsDoc, text), at };
}

function shown(annotationsDoc: LoroDoc, found: AnnotatedText): ThenText {
  if (found.kind === "unavailable") return undefined;
  if (found.kind === "now") return { text: found.text };
  const who = authors(annotationsDoc).get(found.deletedBy) ?? t().unknownAuthor;
  return {
    text: found.text,
    how:
      found.deletedAt > 0
        ? t().deletedOnBy(formatShortDate(found.deletedAt * 1000), who)
        : t().deletedBy(who),
  };
}
