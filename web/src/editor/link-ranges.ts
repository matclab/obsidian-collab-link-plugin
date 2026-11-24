// Where a text's links are (docs/phase-19-liens.md, decisions 1, 3 and 9):
// its `[[…]]`, and its links to a document of a server written without
// the key (ADR-0045 §2), by the editor's own parser — nothing in code is
// taken —, for the Obsidian plugin to translate them at the edges of
// sharing. Pure.
import { Text } from "@codemirror/state";
import { parseWhole } from "../outline/outline.js";
import { type WikilinkKind, readWikilink } from "../render/index.js";

export interface WikilinkRange {
  from: number;
  to: number;
  /** As written, before its `|`. */
  target: string;
  alias: string | null;
  kind: WikilinkKind;
}

export interface DocumentLinkRange {
  from: number;
  to: number;
  /** Its text, its `\[`, `\]` and `\\` read; null for an automatic link. */
  text: string | null;
  documentId: string;
  /** `h`: a heading of that document. */
  heading: string | null;
}

/** Every `[[…]]` of `text`, in order. */
export function wikilinksIn(text: string): WikilinkRange[] {
  const out: WikilinkRange[] = [];
  parseWhole(Text.of(text.split("\n"))).iterate({
    enter: (node) => {
      if (node.name !== "Wikilink") return;
      const found = readWikilink(text.slice(node.from, node.to), 0);
      if (found)
        out.push({
          from: node.from,
          to: node.to,
          target: found.target,
          alias: found.alias,
          kind: found.kind,
        });
      return false;
    },
  });
  return out;
}

/** The document `address` names on `origin`'s server, if it is an address
 * without a key (`?doc=`, `#h=` alone). */
function documentOf(
  address: string,
  origin: string,
): { documentId: string; heading: string | null } | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const documentId = url.searchParams.get("doc");
  if (!documentId) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].some((name) => name !== "h")) return null;
  return { documentId, heading: fragment.get("h") || null };
}

/** Every link of `text` to a document of `origin`'s server, written
 * without its key: `[t](address)` or `<address>`, in order. */
export function documentLinksIn(
  text: string,
  origin: string,
): DocumentLinkRange[] {
  const out: DocumentLinkRange[] = [];
  parseWhole(Text.of(text.split("\n"))).iterate({
    enter: (ref) => {
      if (ref.name !== "Link" && ref.name !== "Autolink") return;
      const node = ref.node;
      const url = node.getChild("URL");
      if (!url) return false;
      const address = text.slice(url.from, url.to).replace(/^<(.*)>$/, "$1");
      const found = documentOf(address, origin);
      if (!found) return false;
      let shown: string | null = null;
      if (node.name === "Link") {
        const [open, close] = node.getChildren("LinkMark");
        if (!open || !close) return false;
        shown = text.slice(open.to, close.from).replace(/\\([[\]\\])/g, "$1");
      }
      out.push({ from: node.from, to: node.to, text: shown, ...found });
      return false;
    },
  });
  return out;
}
