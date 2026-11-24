// Obsidian's `[[…]]` (docs/phase-19-liens.md, decision 7; ADR-0045 §1 and
// §3), read alike by the preview's markdown-it rule and the editor's
// parser: this one scanner, used by both.

/** What a `[[…]]` is: a heading of this document, a block of it (not
 * followed in the page), or a note of someone's vault (not shared). */
export type WikilinkKind = "heading" | "block" | "note";

export interface Wikilink {
  /** Where it ends: just after its `]]`. */
  end: number;
  kind: WikilinkKind;
  /** As written, before its `|`. */
  target: string;
  /** After its first `|`, if not blank. */
  alias: string | null;
  /** A heading's path: `#Parent#Enfant`, `["Parent", "Enfant"]`. */
  path: string[];
  /** What the page shows of it: its alias, else its target without a
   * leading `#` (what Obsidian's live preview shows, *Relevé 19.0*). */
  shown: string;
}

/** The `[[…]]` that starts at `pos` in `text`, if one does: `[[` not right
 * after a `!` (an embed stays text), then up to the first `]]` on its
 * line, with neither `[` nor `]` inside, its target not blank. */
export function readWikilink(text: string, pos: number): Wikilink | null {
  if (text[pos] !== "[" || text[pos + 1] !== "[") return null;
  if (pos > 0 && text[pos - 1] === "!") return null;
  const close = text.indexOf("]]", pos + 2);
  if (close < 0) return null;
  const inner = text.slice(pos + 2, close);
  if (/[[\]\n]/.test(inner)) return null;
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const written = bar < 0 ? "" : inner.slice(bar + 1);
  const alias = written.trim() === "" ? null : written;
  if (target.trim() === "") return null;
  let kind: WikilinkKind = "note";
  let path: string[] = [];
  if (target.startsWith("#")) {
    const rest = target.slice(1);
    if (rest.startsWith("^")) kind = "block";
    else {
      path = rest.split("#");
      if (path.some((part) => part.trim() === "")) return null;
      kind = "heading";
    }
  }
  const shown = alias ?? (target.startsWith("#") ? target.slice(1) : target);
  return { end: close + 2, kind, target, alias, path, shown };
}
