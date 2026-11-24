<!-- Over the text, in Write, for an editor (ADR-0046 §3): the
formatting, a click away; hidden by a button of its own. Shows what
`format-toolbar.ts` gives it; acts through its callbacks. One tab stop,
the arrows between its controls; a click leaves the focus in the text. -->
<script lang="ts">
import { flushSync } from "svelte";
import { constructName } from "../../editor/construct-name.js";
import type { ConstructId, LineConstruct } from "../../editor/constructs.js";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";

interface Props {
  onRun: (id: ConstructId) => void;
  onShown: (shown: boolean) => void;
  /** The shortcut of a construct, as this platform writes it. */
  shortcuts: Partial<Record<ConstructId, string>>;
  /** Opens the writing help; without it, no help button. */
  onHelp?: () => void;
}
const { onRun, onShown, shortcuts, onHelp }: Props = $props();

let visible = $state(true);
let shown = $state(true);
let on = $state<ReadonlySet<ConstructId>>(new Set());
let form = $state<LineConstruct["id"] | "mixed" | null>("paragraph");
let menuOpen = $state(false);
let images = $state(false);
let narrow = $state(false);
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let menu = $state<HTMLElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let insertButton = $state<HTMLButtonElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let bar = $state<HTMLElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let root = $state<HTMLElement>();

export function setVisible(next: boolean): void {
  visible = next;
}
/** On a narrow view, the numbered list and the checklist go in the
 * menu, which becomes More. */
export function setNarrow(next: boolean): void {
  narrow = next;
}
export function setShown(next: boolean): void {
  shown = next;
}
/** Whether an image may be inserted (ADR-0057 §8): known once the
 * server's configuration is. */
export function setImages(next: boolean): void {
  images = next;
}
export function setState(
  next: ReadonlySet<ConstructId>,
  nextForm: LineConstruct["id"] | "mixed" | null,
): void {
  on = next;
  form = nextForm;
}

/** The forms the paragraph menu offers; another heading's level only
 * when it is the form (the / menu has them all). */
const FORMS: LineConstruct["id"][] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "quote",
];
const forms = $derived.by((): LineConstruct["id"][] => {
  if (form === null || form === "mixed" || FORMS.includes(form)) return FORMS;
  return [...FORMS, form];
});

/** What the insert menu puts after the block of the caret. */
const INSERTS: ConstructId[] = [
  "table",
  "callout",
  "codeBlock",
  "mathBlock",
  "diagram",
  "rule",
  "footnote",
];
const inserts = $derived(images ? [...INSERTS, "image" as const] : INSERTS);

function chooseForm(event: Event): void {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (value) onRun(value as ConstructId);
}

function openMenu(): void {
  menuOpen = !menuOpen;
  flushSync();
  if (menuOpen) menu?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
}

function closeMenu(refocus: boolean): void {
  menuOpen = false;
  flushSync();
  if (refocus) insertButton?.focus();
}

function choose(id: ConstructId): void {
  closeMenu(false);
  onRun(id);
}

function menuKeys(event: KeyboardEvent): void {
  if (!menu) return;
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  const at = items.indexOf(event.target as HTMLElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus();
}

/** Hidden or shown; from the keyboard, the focus on the button that
 * undoes it (a click with the mouse leaves it in the text). */
function toggle(event: MouseEvent, next: boolean): void {
  const focused = document.activeElement === event.currentTarget;
  onShown(next);
  flushSync();
  if (!focused || !root) return;
  root
    .querySelector<HTMLElement>(next ? ".hide-toolbar" : ".show-toolbar")
    ?.focus();
}

/** Closed when the focus leaves it and its button. */
function leaving(event: FocusEvent): void {
  const to = event.relatedTarget as Node | null;
  if (menuOpen && !menu?.contains(to) && !insertButton?.contains(to))
    closeMenu(false);
}

const BUTTONS: {
  id: ConstructId;
  icon?: "link" | "bulletList" | "orderedList" | "taskList";
  letter?: string;
}[] = [
  { id: "bold", letter: "B" },
  { id: "italic", letter: "I" },
  { id: "link", icon: "link" },
  { id: "bulletList", icon: "bulletList" },
  { id: "orderedList", icon: "orderedList" },
  { id: "taskList", icon: "taskList" },
];

/** What a narrow view moves from the bar to the menu. */
const MOVED: ConstructId[] = ["orderedList", "taskList"];
const shownButtons = $derived(
  narrow ? BUTTONS.filter((button) => !MOVED.includes(button.id)) : BUTTONS,
);

function label(id: ConstructId): string {
  const name = constructName(id);
  const keys = shortcuts[id];
  return keys ? t().withShortcut(name, keys) : name;
}

// A click keeps the focus, and the selection, in the text.
function keep(event: MouseEvent): void {
  event.preventDefault();
}

/** The arrows move between the controls; one of them in the tab order. */
function arrows(event: KeyboardEvent): void {
  if (!bar) return;
  const controls = Array.from(
    bar.querySelectorAll<HTMLElement>(".format-control"),
  );
  const at = controls.indexOf(event.target as HTMLElement);
  if (at < 0) return;
  // A select's own arrows are up and down.
  const next =
    event.key === "ArrowRight"
      ? (at + 1) % controls.length
      : event.key === "ArrowLeft"
        ? (at - 1 + controls.length) % controls.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? controls.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  for (const [index, control] of controls.entries()) {
    control.tabIndex = index === next ? 0 : -1;
  }
  controls[next]?.focus();
}
</script>

<div class="format-toolbar" hidden={!visible} bind:this={root}>
  {#if shown}
    <div class="format-controls" role="toolbar" aria-label={t().formatting} tabindex="-1" bind:this={bar} onkeydown={arrows}>
      {#snippet tool(button: (typeof BUTTONS)[number], index: number)}
        <button
          class="format-control quiet"
          class:letter={button.letter !== undefined}
          class:italic={button.id === "italic"}
          tabindex={index === 0 ? 0 : -1}
          aria-label={constructName(button.id)}
          aria-pressed={button.id === "link" ? undefined : on.has(button.id)}
          title={label(button.id)}
          onmousedown={keep}
          onclick={() => onRun(button.id)}
        >{#if button.icon}<Icon name={button.icon} />{:else}<span aria-hidden="true">{button.letter}</span>{/if}</button>
      {/snippet}
      {#each shownButtons.slice(0, 3) as button, index (button.id)}{@render tool(button, index)}{/each}
      <!-- Disabled where no line has a form (a code block, the YAML
      header); "Mixed" where the lines touched differ. -->
      <select class="format-control paragraph-style" tabindex="-1" aria-label={t().paragraphStyle} title={t().paragraphStyle} value={form === null || form === "mixed" ? "" : form} disabled={form === null} onchange={chooseForm}>
        {#if form === null || form === "mixed"}<option value="" disabled>{form === "mixed" ? t().mixedStyles : "—"}</option>{/if}
        {#each forms as each (each)}<option value={each}>{constructName(each)}</option>{/each}
      </select>
      {#each shownButtons.slice(3) as button, index (button.id)}{@render tool(button, index + 3)}{/each}
      <div class="insert" onfocusout={leaving}>
        <button class="format-control quiet" tabindex="-1" bind:this={insertButton} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={narrow ? t().moreFormatting : t().insert} title={narrow ? t().moreFormatting : t().insert} onmousedown={keep} onclick={openMenu}><Icon name={narrow ? "more" : "insert"} /></button>
        {#if menuOpen}
          <ul class="insert-menu" role="menu" aria-label={narrow ? t().moreFormatting : t().insert} bind:this={menu} onkeydown={menuKeys}>
            {#if narrow}
              {#each MOVED as id (id)}
                <li role="none"><button role="menuitemcheckbox" aria-checked={on.has(id)} tabindex="-1" onmousedown={keep} onclick={() => choose(id)}>{constructName(id)}</button></li>
              {/each}
              <li role="separator"></li>
            {/if}
            {#each inserts as id (id)}
              <li role="none"><button role="menuitem" tabindex="-1" onmousedown={keep} onclick={() => choose(id)}>{constructName(id)}</button></li>
            {/each}
          </ul>
        {/if}
      </div>
      {#if onHelp}<button class="format-control toolbar-help quiet" tabindex="-1" aria-label={t().helpTitle} title={t().helpTitle} onmousedown={keep} onclick={onHelp}><Icon name="help" /><span class="toolbar-help-label">{t().help}</span></button>{/if}
      <button class="format-control hide-toolbar quiet" tabindex="-1" aria-label={t().hideToolbar} title={t().hideToolbar} onmousedown={keep} onclick={(event) => toggle(event, false)}><Icon name="collapse" /></button>
    </div>
  {:else}
    <button class="show-toolbar quiet" aria-label={t().showToolbar} title={t().showToolbar} onclick={(event) => toggle(event, true)}><Icon name="format" /></button>
  {/if}
</div>

<style>
  /* Named beside its icon (ADR-0064, AC10); on a narrow view, the icon. */
  .toolbar-help-label {
    margin-inline-start: 0.3rem;
  }
  @container document-view (max-width: 56.25rem) {
    .toolbar-help-label {
      display: none;
    }
  }
  /* First in the bar over the text, which aligns the rest to the right. */
  .format-toolbar {
    margin-inline-end: auto;
  }
  .format-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
  }
  .format-control {
    min-width: 2rem;
    justify-content: center;
  }
  .letter span {
    font-weight: 700;
    font-size: 1rem;
  }
  .italic span {
    font-style: italic;
    font-weight: 600;
    font-family: var(--font-doc);
  }
  .paragraph-style {
    font: inherit;
    font-size: 0.875rem;
    max-width: 9rem;
  }
  .insert {
    position: relative;
  }
  .insert-menu {
    position: absolute;
    z-index: 30;
    top: 100%;
    /* Its button is near the bar's end: open towards the text. */
    right: 0;
    margin: 0.25rem 0 0;
    padding: 0.25rem;
    list-style: none;
    min-width: 12rem;
    border: 1px solid var(--rule);
    border-radius: var(--radius-m);
    background: var(--paper-2);
    box-shadow: var(--shadow);
  }
  .insert-menu button {
    width: 100%;
    justify-content: flex-start;
    border: 0;
    background: transparent;
    color: var(--ink);
  }
  .insert-menu [role="separator"] {
    margin: 0.25rem 0;
    border-top: 1px solid var(--rule);
  }
  .insert-menu button:hover,
  .insert-menu button:focus-visible {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }
</style>
