import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type Extension, Facet, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { leavingHref, readWikilink } from "../render/index.js";
import { footnoteJump } from "./footnote-jump.js";

/** The address of the inline link or autolink at `pos` (on its text or its
 * markup), as written; for a `[[…]]` to a heading, `#` and its path
 *; null elsewhere, for a reference link, and for a `[[…]]` to a
 * note or a block. */
export function hrefAt(tree: Tree, doc: Text, pos: number): string | null {
  for (const side of [1, -1] as const) {
    for (
      let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(
        pos,
        side,
      );
      node;
      node = node.parent
    ) {
      if (node.name === "Wikilink") {
        const found = readWikilink(doc.sliceString(node.from, node.to), 0);
        return found?.kind === "heading"
          ? `#${encodeURIComponent(found.path.join("#"))}`
          : null;
      }
      if (node.name !== "Link" && node.name !== "Autolink") continue;
      const url = node.getChild("URL");
      if (!url) return null;
      // `[t](<an address>)`: the brackets are not part of it.
      return doc.sliceString(url.from, url.to).replace(/^<(.*)>$/, "$1");
    }
  }
  return null;
}

/** Who goes where an in-document link, `[t](#x)`, leads: given `x`,
 * decoded. The view adds itself once it has its
 * outline. */
export const anchorFollowers = Facet.define<(id: string) => void>();

/** `#x` decoded, `x` as written if malformed; null for `#` alone. */
function anchorId(href: string): string | null {
  const id = href.slice(1);
  if (id === "") return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** Ctrl/Cmd+click on a link: one that leaves the
 * document opens through `open`, by the preview's rules (`leavingHref`);
 * one inside it, `#x`, goes to `anchorFollowers`; any other link does
 * nothing, never replacing the page's fragment, which holds the key
 * (ADR-0021 §3). On a footnote's reference, the caret goes to its text;
 * on its definition's label, back after its first reference. A plain click only
 * places the caret. */
export function linkClicks(open: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const href = hrefAt(syntaxTree(view.state), view.state.doc, pos);
      if (href === null) {
        if (!jumpToFootnote(view, pos)) return false;
        event.preventDefault();
        return true;
      }
      event.preventDefault();
      if (href.startsWith("#")) {
        const id = anchorId(href);
        if (id !== null) {
          for (const follow of view.state.facet(anchorFollowers)) follow(id);
        }
        return true;
      }
      const url = leavingHref(href);
      if (url) open(url);
      return true;
    },
  });
}

/** The other end of the footnote at `pos`, by the whole tree: its
 * definitions are usually at the text's end, past what is parsed. */
function jumpToFootnote(view: EditorView, pos: number): boolean {
  const { state } = view;
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const to = footnoteJump(tree, state.doc, pos);
  if (to === null) return false;
  view.dispatch({
    selection: { anchor: to },
    effects: EditorView.scrollIntoView(to, { y: "center" }),
    userEvent: "select",
  });
  return true;
}

/** A new tab, without opener nor referrer, as the preview's links. */
export function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
