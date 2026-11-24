import { syntaxTree } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import type { Role } from "../../../lib/src/index.js";
import type { ConstructId } from "../../editor/constructs.js";
import type { DocumentEditor } from "../../editor/editor.js";
import {
  activeConstructs,
  paragraphForm,
  runConstruct,
} from "../../editor/format-commands.js";
import { mayInsertImage } from "../../editor/image-insertion.js";
import { t } from "../../i18n/index.js";
import { count } from "../../perf/index.js";
import type { ViewSwitch } from "../reading/view-switch.js";
import { NEVER, type ScreenQuery } from "../view-width.js";
import Toolbar from "./FormatToolbar.svelte";

/** Where this browser keeps the toolbar hidden: a
 * preference, never shared. */
export const TOOLBAR_KEY = "obsidian-collab:toolbar";

/** Shown, unless this device hid it, in `storage`. */
export function storedToolbar(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(TOOLBAR_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Keeps the choice, where storage allows; the default is not written. */
export function storeToolbar(
  shown: boolean,
  storage: Storage | undefined,
): void {
  try {
    if (shown) storage?.removeItem(TOOLBAR_KEY);
    else storage?.setItem(TOOLBAR_KEY, "hidden");
  } catch {
    // Kept for this page only.
  }
}

/** The shortcuts of `editor.ts`'s FORMAT_KEYS, as a platform writes them. */
export function shortcutLabels(
  mac: boolean,
): Partial<Record<ConstructId, string>> {
  const mod = mac ? "⌘" : `${t().keyCtrl}+`;
  const shift = mac ? "⇧" : `${t().keyShift}+`;
  return {
    bold: `${mod}B`,
    italic: `${mod}I`,
    code: `${mod}E`,
    link: `${mod}K`,
    strikethrough: mac ? `${shift}${mod}X` : `${mod}${shift}X`,
  };
}

export interface FormatToolbar {
  destroy(): void;
}

/** The formatting toolbar (ADR-0046 §3), first in the bar over
 * the text: for an editor in the page's editor only — a host's has its
 * own (ADR-0046 §7). Shown in Write over the editor; its state is the
 * selection's, computed once per update that moves it, changes the text
 * or the parse, and only while it shows. */
export function createFormatToolbar(
  views: ViewSwitch,
  editor: DocumentEditor,
  options: {
    role: Role;
    preferences: Storage | undefined;
    mac: boolean;
    /** The view narrow: the bar shorter. */
    narrow?: ScreenQuery;
    /** Opens the writing help. */
    onHelp?: () => void;
  },
): FormatToolbar | undefined {
  if (editor.hosted || options.role !== "edit") return undefined;
  const { view } = editor;
  let shown = storedToolbar(options.preferences);
  const toolbar = mount(Toolbar, {
    target: views.bar,
    anchor: views.bar.firstChild ?? undefined,
    props: {
      shortcuts: shortcutLabels(options.mac),
      ...(options.onHelp && { onHelp: options.onHelp }),
      onRun(id: ConstructId) {
        runConstruct(id)(view);
        view.focus();
      },
      onShown(next: boolean) {
        shown = next;
        storeToolbar(next, options.preferences);
        apply();
      },
    },
  });
  // Over the editor: the view hides it in History and under the preview.
  const showing = () => shown && !view.dom.hidden;
  const refresh = () => {
    if (!showing()) return;
    count("toolbar.state");
    const on = activeConstructs(view.state);
    toolbar.setState(on, paragraphForm(view.state, on));
    toolbar.setImages(mayInsertImage(view.state));
  };
  const apply = () => {
    toolbar.setVisible(!view.dom.hidden);
    toolbar.setShown(shown);
    refresh();
    flushSync();
  };
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (
          update.selectionSet ||
          update.docChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState) ||
          mayInsertImage(update.state) !== mayInsertImage(update.startState)
        ) {
          refresh();
          flushSync();
        }
      }),
    ),
  });
  const narrow = options.narrow ?? NEVER;
  const fit = () => {
    toolbar.setNarrow(narrow.matches());
    flushSync();
  };
  narrow.onChange(fit);
  views.onMode(apply);
  fit();
  apply();
  return {
    destroy() {
      void unmount(toolbar);
    },
  };
}
