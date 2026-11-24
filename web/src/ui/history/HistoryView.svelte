<!-- The history: versions, newest first, and what
can be done with the selected one. Shows what `history-view.ts` gives it;
acts through its callbacks. The selected version's text and changes are
drawn by `history-view.ts` below this component. -->
<script lang="ts">
import { t } from "../../i18n/index.js";
import SignatureMark from "../annotations/SignatureMark.svelte";
import type { HistoryRow } from "./history-model.js";

type Mode = "text" | "changes";

interface Props {
  canName: boolean;
  canRestore: boolean;
  onSelect: (key: string) => void;
  onMode: (mode: Mode) => void;
  onName: (name: string) => void;
  onDelete: () => void;
  onRestore: () => void;
}
const {
  canName,
  canRestore,
  onSelect,
  onMode,
  onName,
  onDelete,
  onRestore,
}: Props = $props();

let rows = $state<HistoryRow[]>([]);
let selected = $state<string | undefined>(undefined);
let mode = $state<Mode>("text");
let notice = $state("");
let name = $state("");
let summary = $state<{ added: number; removed: number } | undefined>(undefined);

const chosen = $derived(rows.find((row) => row.key === selected));

export function setRows(next: HistoryRow[]): void {
  rows = next;
}

export function setSelected(key: string | undefined): void {
  selected = key;
  notice = "";
  name = "";
}

export function setMode(next: Mode): void {
  mode = next;
}

export function setNotice(text: string): void {
  notice = text;
}

/** In Compare: how many words came and went since the version shown. */
export function setSummary(
  next: { added: number; removed: number } | undefined,
): void {
  summary = next;
}
</script>

<div class="history-list">
  <h2 class="history-list-title">{t().versionsTitle}</h2>
  <p class="history-note">{t().historyNote}</p>
  {#if rows.length === 0}
    <p>{t().noVersion}</p>
  {/if}
  <ul>
    {#each rows as row (row.key)}
      <li>
        <button
          class="history-entry"
          class:named={row.kind === "named"}
          aria-pressed={row.key === selected}
          onclick={() => onSelect(row.key)}
        >
          <!-- The badge on the title's line: a button's height set by a
               host or a theme can't push it onto the next one. -->
          <span class="history-title-row">{row.title}{#if row.current}<span class="history-current">{t().current}</span>{/if}</span>
          {#if row.detail}<span class="history-detail">{row.detail}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</div>
{#if !chosen && rows.length > 0}
  <p class="history-head history-guide">{canRestore ? t().historyGuideEdit : canName ? t().historyGuideSuggest : t().historyGuideRead}</p>
{/if}
{#if chosen}
  <div class="history-head">
    <h2 class="history-title">{t().versionTitle(chosen.title)}</h2>
    {#if chosen.detail}<p class="history-detail">{chosen.detail}</p>{/if}
    {#if chosen.signature.signed}<p class="history-signature"><SignatureMark verdict={chosen.signature} name={chosen.signedName} /></p>{/if}
    <div class="history-modes segmented" role="group">
      <button aria-pressed={mode === "text"} onclick={() => onMode("text")}>{t().seeVersion}</button>
      <button
        aria-pressed={mode === "changes"}
        disabled={chosen.current}
        title={chosen.current ? t().isCurrentVersion : undefined}
        onclick={() => onMode("changes")}>{t().compareNow}</button
      >
    </div>
    {#if chosen.current}
      <p class="history-is-current">{t().isCurrentVersion}</p>
    {:else if mode === "changes" && summary}
      <p class="history-summary">{t().changesLead} <ins>{t().wordsAdded(summary.added)}</ins>, <del>{t().wordsRemoved(summary.removed)}</del></p>
    {/if}
    <div class="history-actions">
      {#if chosen.available}
        {#if canName && chosen.kind === "group"}
          <span class="history-name">
            <input bind:value={name} placeholder={t().versionName} aria-label={t().versionName} maxlength="200" />
            <button onclick={() => onName(name)} disabled={name.trim() === ""}>{t().nameThisVersion}</button>
          </span>
        {/if}
        {#if canRestore && !chosen.current}
          <button onclick={() => onRestore()}>{t().restoreThisText}</button>
          <span class="history-restore-hint">{t().restoreHint}</span>
        {/if}
      {/if}
      {#if canName && chosen.kind === "named"}
        <button onclick={() => onDelete()}>{t().deleteThisName}</button>
      {/if}
      {#if notice}<span class="history-notice">{notice}</span>{/if}
    </div>
  </div>
{/if}

<style>
  .history-list ul {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
    display: grid;
    gap: 2px;
  }
  .history-entry {
    display: grid;
    width: 100%;
    /* Its lines, whatever a host gives its buttons (Obsidian: one line). */
    height: auto;
    border: 0;
    background: transparent;
    text-align: left;
    white-space: normal;
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-s);
  }
  .history-entry[aria-pressed="true"] {
    background: var(--pencil-bg);
  }
  .history-entry.named .history-title-row {
    font-weight: 600;
  }
  .history-list-title {
    margin: 0;
    font-size: 1rem;
  }
  .history-guide {
    margin: 0;
    color: var(--muted);
  }
  .history-restore-hint {
    flex-basis: 100%;
    color: var(--muted);
    font-size: 0.85em;
  }
  .history-detail,
  .history-note,
  .history-is-current {
    color: var(--muted);
    font-size: 0.85em;
    margin: 0.25rem 0;
  }
  .history-current {
    display: inline-block;
    margin-left: 0.4rem;
    vertical-align: middle;
    font-size: 0.75em;
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--ins-bg);
    color: var(--ins);
  }
  /* Never wider than its column: on a narrow view, its title and its two
     modes wrap (the version's date and time made it scroll at 390 px). */
  .history-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .history-title {
    margin: 0;
    font-size: 1.05rem;
    overflow-wrap: anywhere;
  }
  .history-modes {
    justify-self: start;
    max-width: 100%;
    flex-wrap: wrap;
  }
  .history-summary {
    margin: 0;
    color: var(--muted);
    font-size: 0.9em;
  }
  .history-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .history-name {
    display: flex;
    flex: 1 1 18rem;
    flex-wrap: wrap;
    gap: 0.4rem;
    min-width: 0;
  }
  .history-name input {
    flex: 1 1 10rem;
    min-width: 0;
  }
  @container document-view (max-width: 56.25rem) {
    .history-list ul {
      display: flex;
      overflow-x: auto;
      gap: 0.4rem;
    }
    .history-entry {
      width: auto;
      min-width: 11rem;
      border: 1px solid var(--rule);
    }
  }
</style>
