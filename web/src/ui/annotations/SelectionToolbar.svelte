<!-- Next to the selection: comment, suggest,
delete — always an annotation; with the cursor alone, a reviewer
suggests an addition; at a line's start, as a paragraph of its own
before it or in the line (phase 24). A composer opens in place. Shows what
`selection-toolbar.ts` gives it; acts through its callbacks. -->
<script lang="ts">
import { tick } from "svelte";
import { t } from "../../i18n/index.js";
import Icon from "../Icon.svelte";

type Kind = "comment" | "suggest" | "delete";
type Place = "paragraph" | "inline";

interface Props {
  /** Opens the composer for the selection as it is now. */
  onCompose: (kind: Kind) => void;
  /** Returns an error to show, or nothing once done. */
  onSubmit: (
    kind: Kind,
    text: string,
    note: string,
    place?: Place,
  ) => string | undefined;
  onClose: () => void;
}
const { onCompose, onSubmit, onClose }: Props = $props();

let visible = $state(false);
let mode = $state<"selection" | "cursor">("selection");
let composing = $state<Kind | undefined>(undefined);
let original = $state("");
let text = $state("");
let note = $state("");
// Where an addition at the start of a line goes, when there is a choice.
let place = $state<Place | undefined>(undefined);
const id = $props.id();
let error = $state("");
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let element = $state<HTMLElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let field = $state<HTMLTextAreaElement>();
// biome-ignore lint/style/useConst: assigned by bind:this in the template.
let why = $state<HTMLInputElement>();

export function show(next: "selection" | "cursor"): void {
  mode = next;
  visible = true;
}
export function hide(): void {
  visible = false;
  composing = undefined;
  error = "";
}
export function isComposing(): boolean {
  return composing !== undefined;
}
export function root(): HTMLElement | undefined {
  return element;
}
export function compose(kind: Kind, selected: string, preferred?: Place): void {
  composing = kind;
  place = preferred;
  original = selected;
  text = kind === "suggest" ? selected : "";
  note = "";
  error = "";
  visible = true;
  void tick().then(() => (kind === "delete" ? why : field)?.focus());
}
export function fail(message: string): void {
  error = message;
}

function submit(): void {
  if (!composing) return;
  const problem = onSubmit(composing, text, note, place);
  if (problem !== undefined) error = problem;
}

function keys(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
  } else if (
    event.key === "Enter" &&
    (event.ctrlKey ||
      event.metaKey ||
      // The why is one line: Enter there is done.
      (event.target as HTMLElement).classList.contains("composer-note"))
  ) {
    event.preventDefault();
    submit();
  }
}

// A button pressed leaves the focus in the editor: blurred, it would hide
// the line's markup again, the line shrink, and the toolbar move from under
// the pointer before the click. The composer's fields take it.
function press(event: MouseEvent): void {
  if (!composing) event.preventDefault();
}
</script>

<div class="selection-toolbar" class:composing={composing !== undefined} hidden={!visible} bind:this={element} role="toolbar" aria-label={t().annotate} tabindex="-1" onkeydown={keys} onmousedown={press}>
  {#if composing}
    <div class="composer">
      {#if original}
        <p class="composer-original">{#if composing === "comment"}<q>{original}</q>{:else}<del>{original}</del>{/if}</p>
      {/if}
      {#if composing !== "delete"}
      <textarea
        class="composer-text"
        rows={composing === "comment" ? 3 : 2}
        bind:value={text}
        bind:this={field}
        aria-label={composing === "comment" ? t().yourComment : original ? t().replaceWith : t().addText}
        placeholder={composing === "comment" ? t().yourComment : original ? t().replaceWith : t().addText}
      ></textarea>
      {/if}
      {#if place}
        <div class="composer-place" role="radiogroup" aria-label={t().additionPlace}>
          <label><input type="radio" name="{id}-place" value="paragraph" bind:group={place} />{t().paragraphBefore}</label>
          <label><input type="radio" name="{id}-place" value="inline" bind:group={place} />{t().lineStart}</label>
        </div>
      {/if}
      {#if composing !== "comment"}
        <input class="composer-note" bind:value={note} bind:this={why} aria-label={t().why} placeholder={t().why} />
      {/if}
      {#if error}<p class="composer-error" role="alert">{error}</p>{/if}
      <div class="composer-actions">
        <button class="quiet" onclick={onClose}>{t().cancel}</button>
        <button class="primary" onclick={submit}>{composing === "comment" ? t().comment : composing === "delete" ? t().deleteSel : t().suggest}</button>
      </div>
    </div>
  {:else}
    {#if mode === "selection"}
      <button onclick={() => onCompose("comment")}><Icon name="comment" />{t().comment}</button>
    {/if}
    <button onclick={() => onCompose("suggest")}><Icon name="pen" />{t().suggest}</button>
    {#if mode === "selection"}
      <button onclick={() => onCompose("delete")}><Icon name="delete" />{t().deleteSel}</button>
    {/if}
  {/if}
</div>

<style>
  .selection-toolbar {
    position: absolute;
    z-index: 20;
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-m);
    /* On the theme's raised surface, light or dark (it was the ink's
       colour: white on a dark theme). */
    background: var(--paper-2);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .selection-toolbar > button {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 0.9rem;
  }
  .selection-toolbar > button:hover {
    background: color-mix(in srgb, var(--ink) 10%, transparent);
  }
  .selection-toolbar.composing {
    width: min(22rem, calc(100vw - 2rem));
    padding: 0.75rem;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink);
  }
  .composer {
    display: grid;
    gap: 0.5rem;
    width: 100%;
  }
  .composer-original {
    margin: 0;
    font: 0.9375rem / 1.5 var(--font-doc);
    max-height: 4.5em;
    overflow: hidden;
  }
  .composer-text {
    width: 100%;
    resize: vertical;
    font: 0.9375rem / 1.5 var(--font-doc);
  }
  .composer-place {
    display: grid;
    gap: 0.2rem;
    font-size: 0.9rem;
  }
  .composer-place label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .composer-error {
    margin: 0;
    color: var(--del);
    font-size: 0.9rem;
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
</style>
