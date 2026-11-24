import type { AnnotationType } from "../../lib/src/index.js";
import { type NoteEntry, extractNotes, isNoteName } from "./notes.js";

export interface ParsedAnnotation {
  type: AnnotationType;
  /** Offsets into the returned clean `text`, not yet anchored to a real
   * `LoroText` — anchoring happens once the text is inserted into one
   * (`annotations/anchor.ts`), per phase-4 §2. */
  start: number;
  end: number;
  /** An addition's or substitution's proposed text: not in the clean text
   * (ADR-0018), an addition is a point (`start === end`). */
  proposed?: string;
  body?: string;
  /** A suggestion's note: the first entry of its footnote (ADR-0034), or
   * the comment written right after it (the CriticMarkup convention). */
  note?: string;
  /** From its footnote (ADR-0034 §2); the importer's when absent. */
  author?: string;
  createdAt?: number;
  /** The footnote's entries after the first (ADR-0035 §6). */
  replies?: { author?: string; createdAt?: number; body: string }[];
  /** CriticMarkup's bracket syntax carries no author or status — every
   * parsed annotation starts `"open"`; the caller assigns author and lets
   * the user change status afterwards. */
  status: "open";
}

/** What the import had to change to fit ADR-0018: nothing can be anchored
 * inside a proposed text, which is not in `content`. */
export type ImportNotice =
  /** A comment inside an addition, anchored at its insertion point. */
  | { kind: "moved"; type: "comment"; at: number }
  /** Any other annotation inside an addition, dropped: the text it covered
   * stays in the proposed text (a deletion's, a substitution's old text);
   * what it proposed itself is lost. */
  | { kind: "dropped"; type: AnnotationType; at: number }
  // What another tool changed in an export (ADR-0034 §5); `at` in the
  // clean text, the end of it for what has no place any more.
  /** A note no reference names: a comment's, a point comment at the end
   * of the text; a suggestion's, ignored (decided elsewhere). */
  | { kind: "orphanNote"; name: string; at: number }
  /** `[^sg-N]` after no suggestion: decided by another tool. */
  | { kind: "decidedOutside"; name: string; at: number }
  /** A name referenced, or defined, a second time: read without note. */
  | { kind: "duplicateName"; name: string; at: number }
  /** A suggestion without its note (the importer's), or a comment's
   * reference without one (nothing to say: its text stays). */
  | { kind: "noNote"; name?: string; type: AnnotationType; at: number }
  /** `{==…==}` that no reference nor comment follows: text. */
  | { kind: "bareHighlight"; at: number };

export interface ParseResult {
  text: string;
  annotations: ParsedAnnotation[];
  /** For the user: what was moved or dropped, empty for a document our
   * own `formatCriticMarkup` wrote. */
  notices: ImportNotice[];
}

// addition/deletion recurse (a comment or substitution can nest inside
// them, ADR-0012's "imbrication" allowance) — comment and substitution are
// parsed as leaves: real CriticMarkup comment bodies and substitution
// old/new text are plain text, never containing further markers.
// A highlight recurses too: a comment's range may hold suggestions.
type TreeNode =
  | { kind: "text"; value: string }
  | { kind: "wrap"; type: "addition" | "deletion"; children: TreeNode[] }
  | { kind: "highlight"; children: TreeNode[] }
  | { kind: "substitution"; oldText: string; replacement: string }
  | { kind: "comment"; body: string }
  /** `[^cm-N]` or `[^sg-N]` (ADR-0034 §1). */
  | { kind: "reference"; name: string };

const REFERENCE = /^\[\^((?:cm|sg)-[0-9]+)\]/;

function parseNodes(
  markdown: string,
  start: number,
  stopAt?: "++}" | "--}" | "==}",
): { nodes: TreeNode[]; nextIndex: number } {
  const nodes: TreeNode[] = [];
  let i = start;
  let textBuf = "";
  function flush(): void {
    if (textBuf) {
      nodes.push({ kind: "text", value: textBuf });
      textBuf = "";
    }
  }

  while (i < markdown.length) {
    if (stopAt && markdown.startsWith(stopAt, i)) {
      flush();
      return { nodes, nextIndex: i + 3 };
    }
    if (markdown.startsWith("{++", i)) {
      flush();
      const inner = parseNodes(markdown, i + 3, "++}");
      nodes.push({ kind: "wrap", type: "addition", children: inner.nodes });
      i = inner.nextIndex;
      continue;
    }
    if (markdown.startsWith("{--", i)) {
      flush();
      const inner = parseNodes(markdown, i + 3, "--}");
      nodes.push({ kind: "wrap", type: "deletion", children: inner.nodes });
      i = inner.nextIndex;
      continue;
    }
    if (markdown.startsWith("{==", i)) {
      flush();
      const inner = parseNodes(markdown, i + 3, "==}");
      nodes.push({ kind: "highlight", children: inner.nodes });
      i = inner.nextIndex;
      continue;
    }
    if (markdown.startsWith("[^", i)) {
      const name = REFERENCE.exec(markdown.slice(i, i + 32))?.[1];
      if (name !== undefined && isNoteName(name)) {
        flush();
        nodes.push({ kind: "reference", name });
        i += name.length + 3;
        continue;
      }
    }
    if (markdown.startsWith("{~~", i)) {
      flush();
      const arrowIndex = markdown.indexOf("~>", i + 3);
      if (arrowIndex === -1) {
        throw new Error(
          `malformed substitution marker at offset ${i}: missing ~>`,
        );
      }
      const endIndex = markdown.indexOf("~~}", arrowIndex + 2);
      if (endIndex === -1) {
        throw new Error(
          `malformed substitution marker at offset ${i}: missing closing ~~}`,
        );
      }
      nodes.push({
        kind: "substitution",
        oldText: markdown.slice(i + 3, arrowIndex),
        replacement: markdown.slice(arrowIndex + 2, endIndex),
      });
      i = endIndex + 3;
      continue;
    }
    if (markdown.startsWith("{>>", i)) {
      flush();
      const endIndex = markdown.indexOf("<<}", i + 3);
      if (endIndex === -1) {
        throw new Error(
          `malformed comment marker at offset ${i}: missing closing <<}`,
        );
      }
      nodes.push({ kind: "comment", body: markdown.slice(i + 3, endIndex) });
      i = endIndex + 3;
      continue;
    }
    textBuf += markdown[i];
    i++;
  }
  flush();
  if (stopAt) {
    throw new Error(`unterminated marker: expected closing ${stopAt}`);
  }
  return { nodes, nextIndex: i };
}

/** What the names of one file refer to, across the whole tree. */
interface Names {
  notes: ReadonlyMap<string, NoteEntry[]>;
  /** Names already referenced: a second reference is a duplicate. */
  used: Set<string>;
  /** The file has notes: a suggestion without one is said. */
  withNotes: boolean;
  /** Suggestions already said to have no note of their own. */
  said: WeakSet<ParsedAnnotation>;
}

type Claim = "named" | "duplicate" | "noNote";

function claim(names: Names, name: string): Claim {
  if (names.used.has(name)) return "duplicate";
  names.used.add(name);
  return names.notes.has(name) ? "named" : "noNote";
}

/** Names of annotations, until their notes are read. */
const named = new WeakMap<ParsedAnnotation, string>();

function flatten(nodes: readonly TreeNode[], names: Names): ParseResult {
  let text = "";
  const annotations: ParsedAnnotation[] = [];
  const notices: ImportNotice[] = [];
  // What the previous node was, if a reference or a comment right after
  // it is about it: a suggestion (its name, or its note), a highlight
  // (the comment's range).
  let previous:
    | { kind: "suggestion"; annotation: ParsedAnnotation }
    | { kind: "highlight"; start: number; end: number }
    | undefined;
  for (const node of nodes) {
    const before = previous;
    previous = undefined;
    const aboutIt =
      node.kind === "comment" ||
      (node.kind === "reference" &&
        node.name.startsWith(before?.kind === "highlight" ? "cm" : "sg"));
    if (before?.kind === "highlight" && !aboutIt) {
      notices.push({ kind: "bareHighlight", at: before.start });
    }
    if (node.kind === "text") {
      text += node.value;
      continue;
    }
    if (node.kind === "reference") {
      const { name } = node;
      const result = claim(names, name);
      if (name.startsWith("sg")) {
        if (before?.kind !== "suggestion") {
          notices.push({ kind: "decidedOutside", name, at: text.length });
          continue;
        }
        const suggestion = before.annotation;
        if (result === "named") named.set(suggestion, name);
        else {
          names.said.add(suggestion);
          notices.push(
            result === "duplicate"
              ? { kind: "duplicateName", name, at: suggestion.start }
              : {
                  kind: "noNote",
                  name,
                  type: suggestion.type,
                  at: suggestion.start,
                },
          );
        }
        continue;
      }
      const [start, end] =
        before?.kind === "highlight"
          ? [before.start, before.end]
          : [text.length, text.length];
      if (result === "named") {
        const comment: ParsedAnnotation = {
          type: "comment",
          start,
          end,
          status: "open",
        };
        named.set(comment, name);
        annotations.push(comment);
      } else {
        notices.push(
          result === "duplicate"
            ? { kind: "duplicateName", name, at: start }
            : { kind: "noNote", name, type: "comment", at: start },
        );
      }
      continue;
    }
    if (node.kind === "comment" && before?.kind === "suggestion") {
      before.annotation.note = node.body;
      continue;
    }
    if (node.kind === "comment") {
      // The standard form `{==range==}{>>text<<}`, or a point.
      const [start, end] =
        before?.kind === "highlight"
          ? [before.start, before.end]
          : [text.length, text.length];
      annotations.push({
        type: "comment",
        start,
        end,
        body: node.body,
        status: "open",
      });
      continue;
    }
    if (node.kind === "substitution") {
      const start = text.length;
      text += node.oldText;
      const suggestion: ParsedAnnotation = {
        type: "substitution",
        start,
        end: text.length,
        proposed: node.replacement,
        status: "open",
      };
      previous = { kind: "suggestion", annotation: suggestion };
      annotations.push(suggestion);
      continue;
    }
    const start = text.length;
    const child = flatten(node.children, names);
    if (node.kind === "wrap" && node.type === "addition") {
      // Its text is proposed, not in content (ADR-0018): nothing can be
      // anchored inside it. A comment moves to the insertion point.
      const suggestion: ParsedAnnotation = {
        type: "addition",
        start,
        end: start,
        proposed: child.text,
        status: "open",
      };
      previous = { kind: "suggestion", annotation: suggestion };
      annotations.push(suggestion);
      for (const a of child.annotations) {
        if (a.type === "comment") {
          const moved = { ...a, start, end: start };
          const name = named.get(a);
          if (name !== undefined) named.set(moved, name);
          annotations.push(moved);
          notices.push({ kind: "moved", type: "comment", at: start });
        } else {
          notices.push({ kind: "dropped", type: a.type, at: start });
        }
      }
      for (const n of child.notices) notices.push({ ...n, at: start });
      continue;
    }
    text += child.text;
    for (const a of child.annotations) {
      const shifted = { ...a, start: a.start + start, end: a.end + start };
      const name = named.get(a);
      if (name !== undefined) named.set(shifted, name);
      if (names.said.has(a)) names.said.add(shifted);
      annotations.push(shifted);
    }
    for (const n of child.notices) notices.push({ ...n, at: n.at + start });
    if (node.kind === "highlight") {
      previous = { kind: "highlight", start, end: text.length };
      continue;
    }
    const deletion: ParsedAnnotation = {
      type: "deletion",
      start,
      end: text.length,
      status: "open",
    };
    // Before what it holds: an outer range first, as in creation order.
    annotations.splice(
      annotations.length - child.annotations.length,
      0,
      deletion,
    );
    previous = { kind: "suggestion", annotation: deletion };
  }
  if (previous?.kind === "highlight") {
    notices.push({ kind: "bareHighlight", at: previous.start });
  }
  return { text, annotations, notices };
}

/** A note's entries onto its annotation: the first is the annotation's
 * own (its author, date, text), the others its replies, an empty one
 * skipped. */
function withNote(
  annotation: ParsedAnnotation,
  entries: readonly NoteEntry[],
): ParsedAnnotation {
  const [first, ...rest] = entries;
  const text = first?.text ?? "";
  const replies = rest
    .filter((entry) => entry.text !== "")
    .map((entry) => ({
      ...(entry.author !== undefined && { author: entry.author }),
      ...(entry.createdAt !== undefined && { createdAt: entry.createdAt }),
      body: entry.text,
    }));
  return {
    ...annotation,
    ...(first?.author !== undefined && { author: first.author }),
    ...(first?.createdAt !== undefined && { createdAt: first.createdAt }),
    ...(annotation.type === "comment"
      ? { body: text }
      : text !== "" && { note: text }),
    ...(replies.length > 0 && { replies }),
  };
}

/** Parses CriticMarkup text (hand-written or exported by
 * `formatCriticMarkup`) into clean text plus unanchored annotations — the
 * import half of ADR-0003. Recursive/stack-based (ADR-0012): addition and
 * deletion markers can nest arbitrarily deep; a naive independent-regex
 * parser would mis-scan the first matching close marker regardless of
 * nesting, exactly the corruption ADR-0012 documents. */
export function parseCriticMarkup(markdown: string): ParseResult {
  const { body, notes, duplicates } = extractNotes(markdown);
  const { nodes } = parseNodes(body, 0);
  const names: Names = {
    notes,
    used: new Set(),
    withNotes: notes.size > 0,
    said: new WeakSet(),
  };
  const flat = flatten(nodes, names);
  const { text } = flat;
  const notices = [...flat.notices];
  const annotations = flat.annotations.map((annotation) => {
    const name = named.get(annotation);
    const entries = name === undefined ? undefined : notes.get(name);
    if (entries) return withNote(annotation, entries);
    if (
      names.withNotes &&
      annotation.type !== "comment" &&
      !names.said.has(annotation)
    ) {
      notices.push({
        kind: "noNote",
        type: annotation.type,
        at: annotation.start,
      });
    }
    return annotation;
  });
  // A note whose reference is gone (ADR-0034 §5): a comment's discussion
  // stays, at the end of the text; a suggestion's was decided elsewhere.
  for (const [name, entries] of notes) {
    if (names.used.has(name)) continue;
    notices.push({ kind: "orphanNote", name, at: text.length });
    if (name.startsWith("cm")) {
      annotations.push(
        withNote(
          {
            type: "comment",
            start: text.length,
            end: text.length,
            status: "open",
          },
          entries,
        ),
      );
    }
  }
  for (const name of duplicates) {
    notices.push({ kind: "duplicateName", name, at: text.length });
  }
  // In the text's order (stable: same place, order of reading).
  notices.sort((a, b) => a.at - b.at);
  return { text, annotations, notices };
}
