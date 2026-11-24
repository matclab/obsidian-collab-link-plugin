import { StateEffect } from "@codemirror/state";
import { anchorHeadings } from "../editor/anchor-menu.js";
import { anchorFollowers } from "../editor/link-click.js";
import { pastedLinks } from "../editor/pasted-link.js";
import { t } from "../i18n/index.js";
import type { DocumentKeyring } from "../keyring/hooks.js";
import { followEditor } from "../outline/follow-editor.js";
import { OutlineIndex } from "../outline/outline-index.js";
import type { HeadingTarget } from "../outline/resolve.js";
import {
  type OutlineColumn,
  createOutlineColumn,
} from "../ui/outline/outline-column.js";
import {
  type ReadingSurfaces,
  goToAnchor,
  revealHeading,
} from "../ui/outline/outline-navigation.js";
import type { ViewWidths } from "../ui/view-width.js";
import type { ViewFrame } from "./document-view.js";
import type { WiredClient } from "./wire-client.js";

/** How a view is read, once its editor is wired: the outline,
 * the host's or a column of the view's; `[t](#x)` leading to a heading
 *; a full link pasted made keyless. */
export function wireReading(
  client: Pick<WiredClient, "editor" | "views">,
  options: {
    frame: Pick<ViewFrame, "topbar" | "outline" | "workspace">;
    widths: Pick<ViewWidths, "narrow" | "wide">;
    /** Who shows the outline: the view's own column, or the host's. */
    outline: "page" | "host" | undefined;
    preferences: Storage | undefined;
    apiBase: string;
    keyring: DocumentKeyring | undefined;
    showNotice(text: string, action?: { label: string; run: () => void }): void;
    stops: (() => void)[];
  },
): {
  reveal(target: HeadingTarget): boolean;
  anchor(id: string): boolean;
  column?: OutlineColumn;
} {
  const { frame, widths, keyring, showNotice } = options;
  const keyringFailed = (error: unknown) => console.warn("keyring", error);
  const outline = new OutlineIndex(client.editor.view.state.doc);
  followEditor(client.editor.view, outline);
  const surfaces: ReadingSurfaces = {
    view: client.editor.view,
    previewRoot: client.views.preview.root,
    ownColumn: () => client.views.sideBySide(),
    readingTop: () => Math.max(0, frame.topbar.getBoundingClientRect().bottom),
  };
  const reveal = (target: HeadingTarget) =>
    revealHeading(outline, surfaces, target);
  // `[t](#x)`, in the preview or the editor: a heading.
  const anchor = (id: string) => goToAnchor(outline, surfaces, id);
  const toAnchor = (id: string) => void anchor(id);
  client.views.preview.onAnchor(toAnchor);
  client.editor.view.dispatch({
    effects: [
      StateEffect.appendConfig.of(anchorFollowers.of(toAnchor)),
      // Its headings, offered after `](#` and `[[#`.
      StateEffect.appendConfig.of(anchorHeadings.of(() => outline.current())),
      // A full link pasted: its keyless address.
      pastedLinks({
        origin: new URL(options.apiBase).origin,
        titleOf: (id) => keyring?.titleOf(id),
        converted: (link, keep) => {
          void keyring?.given(link).catch(keyringFailed);
          // Kept only where there is a list: else, said.
          void (keyring?.available() ?? Promise.resolve(false))
            .catch(() => false)
            .then((kept) =>
              showNotice(
                kept ? t().pastedLinkConverted : t().pastedLinkNotKept,
                {
                  label: t().keepFullLink,
                  run: () => {
                    if (!keep()) showNotice(t().pastedLinkGone);
                  },
                },
              ),
            );
        },
      }),
    ],
  });
  if (options.outline === "host") return { reveal, anchor };
  const column = createOutlineColumn(frame.outline, {
    index: outline,
    surfaces,
    views: client.views,
    workspace: frame.workspace,
    narrow: widths.narrow,
    wide: widths.wide,
    preferences: options.preferences,
  });
  options.stops.push(() => column.destroy());
  return { reveal, anchor, column };
}
