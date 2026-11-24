// From a footnote's reference to its text, and back: by the editor's parser,
// which reads `[^x]` as a reference link and
// `[^x]: …` as a paragraph or a link definition opened by it, with the
// preview's rules for what is a footnote (markdown-it-footnote). Pure.
import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { readWikilink } from "../render/index.js";

/** markdown-it-footnote's label: neither a space nor a line break. */
const LABEL = /^\[\^([^ \n\]]+)\]$/;

/** The references, `[^x]` at their offset, in a link definition's
 * address or title, which the editor's parser does not read further:
 * neither escaped, nor in code, nor a link's text (`[^x](u)`), nor in a
 * `[[…]]`, read before the footnotes. */
function referencesIn(text: string): { at: number; written: string }[] {
  const out: { at: number; written: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      close.lastIndex = i + run.length;
      const found = close.exec(text);
      i = found ? found.index + run.length : i + run.length;
      continue;
    }
    const wikilink = readWikilink(text, i);
    if (wikilink) {
      i = wikilink.end;
      continue;
    }
    const written = /^\[\^[^ \n\]]+\](?!\()/.exec(text.slice(i))?.[0];
    if (written) {
      out.push({ at: i, written });
      i += written.length;
      continue;
    }
    i++;
  }
  return out;
}

/** Before a definition's label, on its line: only the markup of quotes,
 * list items, and other definitions, whose text the preview reads as
 * blocks; each after three spaces at most (four continue a
 * paragraph). */
const CONTAINERS =
  /^(?:[ \t]{0,3}(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])|\[\^[^ \n\]]+\]:))*[ \t]{0,3}$/;

export interface FootnoteLabel {
  /** `[^x]`, its brackets in. */
  from: number;
  to: number;
  label: string;
  /** `[^x]:` opening a note's text, rather than a reference. */
  definition: boolean;
}

/** `[^x]` from `from` to `to`, if it is one. */
function labelIn(from: number, to: number, doc: Text): FootnoteLabel | null {
  const label = LABEL.exec(doc.sliceString(from, to))?.[1];
  return label === undefined ? null : labelAt(from, to, label, doc);
}

/** A link's label as the preview matches it (markdown-it's
 * `normalizeReference`): spaces folded, case aside. */
function linkKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
}

/** A reference link's text and its label, `[^1][^2]`, are two for the
 * preview, which reads from the left: in `[^1][^2](address)`, the second
 * opens a link. `[^1](address)` is a link, and so is `[^1][a b]` when
 * `[a b]` is a link's definition: the preview tries links first. */
function labelsOfLink(
  node: SyntaxNode,
  doc: Text,
  links: ReadonlySet<string>,
): FootnoteLabel[] {
  if (node.getChild("URL")) return [];
  const close = node.getChildren("LinkMark")[1];
  const label = node.getChild("LinkLabel");
  const linked = label && doc.sliceString(label.to, label.to + 1) === "(";
  if (
    label &&
    !linked &&
    links.has(linkKey(doc.sliceString(label.from + 1, label.to - 1)))
  ) {
    return [];
  }
  return [
    close && labelIn(node.from, close.to, doc),
    label && !linked && labelIn(label.from, label.to, doc),
  ].filter((it) => it !== null && it !== undefined && it !== false);
}

function labelAt(
  from: number,
  to: number,
  label: string,
  doc: Text,
): FootnoteLabel {
  const line = doc.lineAt(from);
  const definition =
    doc.sliceString(to, to + 1) === ":" &&
    CONTAINERS.test(doc.sliceString(line.from, from));
  return { from, to, label, definition };
}

/** Every footnote label of the text, references and definitions, in
 * order. */
export function footnoteLabels(tree: Tree, doc: Text): FootnoteLabel[] {
  // Links read once the definitions are known, which may come after.
  const labels: (FootnoteLabel | SyntaxNode)[] = [];
  /** The links' definitions, as the preview reads them. */
  const links = new Set<string>();
  // The line where the paragraph of a note's text ends, if it is still
  // open there: a link's definition cannot interrupt it, so the preview
  // reads one on the next line as the note's text.
  let openUntil = -1;
  tree.iterate({
    enter: (ref) => {
      if (ref.name === "Link") {
        labels.push(ref.node);
        return false;
      }
      if (ref.name !== "LinkReference") return;
      // `[^1]: [^2]`: the preview reads a note's text, the editor's parser
      // an address.
      const label = ref.node.getChild("LinkLabel");
      if (!label) return false;
      const definition = labelIn(label.from, label.to, doc);
      if (definition) labels.push(definition);
      // `[^1]: text` then `[a b]:` on the next line: the editor's parser
      // reads a link's definition, the preview the note's text. A note
      // with no text on its line is the accepted divergence of
      // `footnote-jump.property.test.ts`: the preview ends it there.
      const absorbed =
        definition === null && doc.lineAt(ref.from).number === openUntil + 1;
      const noteText = doc.sliceString(label.to + 1, doc.lineAt(ref.from).to);
      openUntil =
        absorbed || (definition !== null && noteText.trim() !== "")
          ? doc.lineAt(ref.to).number
          : -1;
      if (definition === null && !absorbed) {
        links.add(linkKey(doc.sliceString(label.from + 1, label.to - 1)));
      }
      // `[a b]:` then `[^1]: …` on the next line: the editor's parser
      // reads an address there, the preview a note.
      let inNote = definition !== null || absorbed;
      const from = label.to + 1;
      const text = doc.sliceString(from, ref.to);
      for (const { at, written } of referencesIn(text)) {
        const found = labelAt(
          from + at,
          from + at + written.length,
          written.slice(2, -1),
          doc,
        );
        inNote ||= found.definition;
        if (inNote) labels.push(found);
      }
      return false;
    },
  });
  return labels.flatMap((it) =>
    "definition" in it ? [it] : labelsOfLink(it, doc, links),
  );
}

/** Where Ctrl/Cmd+click at `pos` leads: on a footnote's reference, the
 * start of its definition's text (the last one, as the preview); on a
 * definition's label, just after its first reference; null elsewhere,
 * and for a footnote without its other end. */
export function footnoteJump(
  tree: Tree,
  doc: Text,
  pos: number,
): number | null {
  const labels = footnoteLabels(tree, doc);
  const at = labels.find((it) => it.from <= pos && pos <= it.to);
  if (!at) return null;
  const others = labels.filter(
    (it) => it.label === at.label && it.definition !== at.definition,
  );
  // The preview shows a label's last definition.
  const other = at.definition ? others[0] : others.at(-1);
  if (!other) return null;
  if (!other.definition) return other.to;
  const line = doc.lineAt(other.to);
  const text = /^:[ \t]*/.exec(doc.sliceString(other.to, line.to))?.[0] ?? ":";
  return other.to + text.length;
}
