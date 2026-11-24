// A document's full link pasted into the text (docs/phase-19-liens.md,
// decision 12; ADR-0045 §2): what goes in is its address without the key,
// which opens it for whoever already has it and for no one else. Converted
// before it reaches the text: a key once in the text stays in the
// document's history, which compaction keeps (ADR-0017). The full link
// goes back only by the person's choice (`keep`).
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseLinkFragment } from "../../lib/src/index.js";

export interface KeylessForm {
  /** What goes into the text. */
  insert: string;
  /** The full link pasted. */
  link: string;
  documentId: string;
}

/** `[`, `]` and `\` escaped: a title as a link's text. */
const asLinkText = (title: string) => title.replace(/[[\]\\]/g, "\\$&");

/** What goes in for `text` pasted: when it is a full link of a document of
 * this server (`origin`), alone, its address without the key, `h` kept —
 * titled by the list, `titleOf`, else an autolink; else null. */
export function keylessForm(
  text: string,
  origin: string,
  titleOf: (documentId: string) => string | undefined,
): KeylessForm | null {
  const link = text.trim();
  if (link === "" || /\s/.test(link)) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const documentId = url.searchParams.get("doc");
  if (!documentId) return null;
  try {
    parseLinkFragment(url.hash);
  } catch {
    return null;
  }
  const h = new URLSearchParams(url.hash.slice(1)).get("h");
  const address = `${url.origin}${url.pathname}?doc=${encodeURIComponent(documentId)}${
    h ? `#h=${encodeURIComponent(h)}` : ""
  }`;
  const title = titleOf(documentId)?.trim();
  const insert = title ? `[${asLinkText(title)}](${address})` : `<${address}>`;
  return { insert, link, documentId };
}

export interface PastedLinkHooks {
  /** This page's server, whose links are converted. */
  origin: string;
  /** The title « Mes documents » holds of a document, if it is read. */
  titleOf(documentId: string): string | undefined;
  /** A link converted: `keep` puts the full link in the address's place,
   * if that address is still there as it went in, once — false if not. */
  converted(link: string, keep: () => boolean): void;
}

/** The editor's conversion of pasted links, added to a view once its
 * hooks are known (as `anchorFollowers`). */
export function pastedLinks(hooks: PastedLinkHooks): StateEffect<unknown> {
  /** The addresses put in, followed through the edits after. */
  const tracked = new Set<{ from: number; to: number; insert: string }>();
  return StateEffect.appendConfig.of([
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      for (const range of tracked) {
        range.from = update.changes.mapPos(range.from, 1);
        range.to = update.changes.mapPos(range.to, -1);
      }
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        if (view.state.readOnly || view.state.selection.ranges.length > 1)
          return false;
        const text = event.clipboardData?.getData("text/plain");
        const found = text
          ? keylessForm(text, hooks.origin, hooks.titleOf)
          : null;
        if (!found) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: found.insert },
          selection: { anchor: from + found.insert.length },
          userEvent: "input.paste",
          scrollIntoView: true,
        });
        const range = {
          from,
          to: from + found.insert.length,
          insert: found.insert,
        };
        tracked.add(range);
        hooks.converted(found.link, () => {
          if (!tracked.delete(range)) return false;
          if (view.state.sliceDoc(range.from, range.to) !== range.insert)
            return false;
          view.dispatch({
            changes: { from: range.from, to: range.to, insert: found.link },
            userEvent: "input.paste",
          });
          return true;
        });
        return true;
      },
    }),
  ]);
}
