import { mount } from "svelte";
import { constructName } from "../../editor/construct-name.js";
import type { ConstructId } from "../../editor/constructs.js";
import { t } from "../../i18n/index.js";
import { renderMarkdown } from "../../render/index.js";
import { createDialog } from "../dialogs/dialog.js";
import Help from "./WritingHelp.svelte";
import { shortcutLabels } from "./format-toolbar.js";

/** A construction of the help: its example in the dictionary, what the
 * preview draws it as, the editor parser's node for it (WA7). */
export interface HelpEntry {
  id: ConstructId;
  example: () => string;
  drawn: string;
  node: string;
  /** Drawn by the preview's loaders (KaTeX, Pele): its source only. */
  loaded?: true;
}

export const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    id: "bold",
    example: () => t().exampleBold,
    drawn: "strong",
    node: "StrongEmphasis",
  },
  {
    id: "italic",
    example: () => t().exampleItalic,
    drawn: "em",
    node: "Emphasis",
  },
  {
    id: "strikethrough",
    example: () => t().exampleStrikethrough,
    drawn: "s",
    node: "Strikethrough",
  },
  {
    id: "highlight",
    example: () => t().exampleHighlight,
    drawn: "mark",
    node: "Highlight",
  },
  {
    id: "code",
    example: () => t().exampleCode,
    drawn: "code",
    node: "InlineCode",
  },
  { id: "link", example: () => t().exampleLink, drawn: "a", node: "Link" },
  {
    id: "heading1",
    example: () => t().exampleHeading1,
    drawn: "h1",
    node: "ATXHeading1",
  },
  {
    id: "heading2",
    example: () => t().exampleHeading2,
    drawn: "h2",
    node: "ATXHeading2",
  },
  {
    id: "heading3",
    example: () => t().exampleHeading3,
    drawn: "h3",
    node: "ATXHeading3",
  },
  {
    id: "bulletList",
    example: () => t().exampleBulletList,
    drawn: "ul",
    node: "BulletList",
  },
  {
    id: "orderedList",
    example: () => t().exampleOrderedList,
    drawn: "ol",
    node: "OrderedList",
  },
  {
    id: "taskList",
    example: () => t().exampleTaskList,
    drawn: "li.task-list-item",
    node: "Task",
  },
  {
    id: "quote",
    example: () => t().exampleQuote,
    drawn: "blockquote",
    node: "Blockquote",
  },
  {
    id: "callout",
    example: () => t().exampleCallout,
    drawn: ".md-callout",
    node: "Blockquote",
  },
  {
    id: "table",
    example: () => t().exampleTable,
    drawn: "table",
    node: "Table",
  },
  {
    id: "codeBlock",
    example: () => t().exampleCodeBlock,
    drawn: "pre",
    node: "FencedCode",
  },
  {
    id: "mathBlock",
    example: () => t().exampleMathBlock,
    drawn: ".math-display",
    node: "MathBlock",
    loaded: true,
  },
  {
    id: "diagram",
    example: () => t().exampleDiagram,
    drawn: ".mermaid",
    node: "FencedCode",
    loaded: true,
  },
  {
    id: "rule",
    example: () => t().exampleRule,
    drawn: "hr",
    node: "HorizontalRule",
  },
  {
    id: "footnote",
    example: () => t().exampleFootnote,
    drawn: ".footnotes",
    node: "Link",
  },
  {
    id: "image",
    example: () => t().exampleImage,
    drawn: ".attached-image",
    node: "Image",
  },
];

/** An example as the preview renders it, a task's box named for a screen
 * reader as the preview names it. */
export function renderExample(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(source);
  for (const box of Array.from(
    template.content.querySelectorAll("input[type=checkbox]"),
  )) {
    box.setAttribute("aria-label", t().task);
  }
  return template.innerHTML;
}

/** The shortcuts the help lists, as a platform writes them. */
export function helpShortcuts(mac: boolean): { keys: string; what: string }[] {
  const labels = shortcutLabels(mac);
  const named = (
    ["bold", "italic", "link", "code", "strikethrough"] as const
  ).map((id) => ({ keys: labels[id] ?? "", what: constructName(id) }));
  return [
    ...named,
    { keys: "/", what: t().helpSlashMenu },
    {
      keys: mac ? "⌥⌘M" : `${t().keyCtrl}+${t().keyAlt}+M`,
      what: t().helpAnnotate,
    },
    // In the composer or a reply's field (SelectionToolbar, AnnotationCard).
    { keys: mac ? "⌘↩" : `${t().keyCtrl}+${t().keyEnter}`, what: t().helpSend },
    {
      keys: mac ? "⇧⌘↑ ↓" : `${t().keyCtrl}+${t().keyShift}+↑ ↓`,
      what: t().helpMoveSection,
    },
    // Tab indents (ADR-0054); Escape then Tab, or Ctrl+M, leave it to
    // the browser: CodeMirror's own.
    { keys: t().keyTab, what: t().helpIndent },
    {
      keys: mac ? `⇧${t().keyTab}` : `${t().keyShift}+${t().keyTab}`,
      what: t().helpOutdent,
    },
    { keys: `${t().keyEscape}, ${t().keyTab}`, what: t().helpLeaveText },
    { keys: mac ? "⇧⌥M" : `${t().keyCtrl}+M`, what: t().helpTabMode },
    // CodeMirror's own (defaultKeymap, historyKeymap).
    {
      keys: mac ? "⌥↑ ↓" : `${t().keyAlt}+↑ ↓`,
      what: t().helpMoveLines,
    },
    {
      keys: mac ? "⇧⌥↑ ↓" : `${t().keyAlt}+${t().keyShift}+↑ ↓`,
      what: t().helpCopyLines,
    },
    {
      keys: mac ? "⇧⌘K" : `${t().keyCtrl}+${t().keyShift}+K`,
      what: t().helpDeleteLine,
    },
    { keys: mac ? "⌘Z" : `${t().keyCtrl}+Z`, what: t().helpUndo },
    { keys: mac ? "⇧⌘Z" : `${t().keyCtrl}+Y`, what: t().helpRedo },
    {
      keys: `${mac ? "⌘" : t().keyCtrl}+${t().keyClick}`,
      what: t().helpFollow,
    },
  ];
}

export interface WritingHelp {
  open(): void;
}

/** The writing help (ADR-0046 §6), a dialog in `parent`, its
 * view's element: made at its first opening. */
export function createWritingHelp(
  parent: Element,
  options: { mac: boolean },
): WritingHelp {
  let dialog: ReturnType<typeof createDialog> | undefined;
  return {
    open() {
      if (!dialog) {
        dialog = createDialog(t().helpTitle, "help-dialog", parent);
        mount(Help, {
          target: dialog.body,
          props: { shortcuts: helpShortcuts(options.mac) },
        });
      }
      dialog.open();
    },
  };
}
